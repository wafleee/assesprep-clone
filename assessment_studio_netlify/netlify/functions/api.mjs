const ENDPOINT = (process.env.GEMINI_API_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
// Netlify stops synchronous functions at 60 s; leave room to send the error back.
const TOTAL_BUDGET_MS = 54000;
const PER_MODEL_TIMEOUT_MS = 40000;

const QUESTION_TYPES = ['Long answer', 'MCQ', 'MCQ Multiple', 'True / False', 'Fill in the blanks', 'Question with sub-parts'];
const CHOICE_TYPES = ['MCQ', 'MCQ Multiple', 'True / False'];
const LANGUAGE_SUBJECTS = ['HINDI', 'SPANISH', 'FRENCH'];

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: QUESTION_TYPES },
          text: { type: 'string', description: 'Complete student-facing question. Use $...$ for maths.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Answer options for MCQ, MCQ Multiple and True / False. Empty for written questions.' },
          correct: { type: 'array', items: { type: 'integer' }, description: 'Zero-based indexes of the correct options. Empty for written questions.' },
          marks: { type: 'integer', minimum: 1, maximum: 12 },
          explanation: { type: 'string', description: 'Worked answer or mark scheme.' },
        },
        required: ['type', 'text', 'options', 'correct', 'marks', 'explanation'],
      },
    },
  },
  required: ['questions'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          score: { type: 'number', minimum: 0 },
          result: { type: 'string', enum: ['Correct', 'Partially correct', 'Needs improvement', 'Not answered'] },
          feedback: { type: 'string' },
          improvement: { type: 'string' },
        },
        required: ['id', 'score', 'result', 'feedback', 'improvement'],
      },
    },
  },
  required: ['results'],
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function modelChain() {
  const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const primary = list(process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite');
  const fallbacks = list(process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.8-flash');
  return [...new Set([...primary, ...fallbacks])];
}

async function callGemini({ system, user, schema }) {
  if (process.env.ASSESSMENT_AI_ENABLED === 'false') throw new HttpError('AI generation is switched off for this site.', 503);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError('GEMINI_API_KEY is not set in Netlify.', 500);

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const failures = [];
  for (const model of modelChain()) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) break;
    const generationConfig = { responseMimeType: 'application/json', responseJsonSchema: schema };
    // Lite models default to minimal thinking; larger ones default to medium, which is slow.
    if (!/lite/i.test(model)) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    let res;
    try {
      res = await fetch(`${ENDPOINT}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig,
        }),
        signal: AbortSignal.timeout(Math.min(remaining, PER_MODEL_TIMEOUT_MS)),
      });
    } catch (e) {
      failures.push(`${model}: ${e.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
      continue;
    }
    const raw = await res.text();
    if (res.status === 401 || res.status === 403) throw new HttpError('The Gemini API key was rejected. Check GEMINI_API_KEY in Netlify.', 500);
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.parse(raw).error?.message || ''; } catch {}
      failures.push(`${model}: HTTP ${res.status}${detail ? ` (${detail.slice(0, 120)})` : ''}`);
      continue;
    }
    try {
      const data = JSON.parse(raw);
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      return { data: JSON.parse(text), model };
    } catch {
      failures.push(`${model}: unreadable response`);
    }
  }
  const busy = failures.some(f => / HTTP (429|503)/.test(f));
  throw new HttpError(
    `${busy ? 'Gemini is busy or rate-limited right now. Wait a moment and try again.' : 'Gemini could not complete the request.'} (${failures.join(' | ') || 'no models tried'})`,
    503,
  );
}

function documentsText(documents, limit) {
  let out = '';
  for (const d of documents || []) {
    if (out.length >= limit) break;
    out += `\n--- ${d.name} ---\n${String(d.text || '').slice(0, limit - out.length)}`;
  }
  return out;
}

function normalizeQuestion(q, i, requestedType) {
  let type = [requestedType, q.type].find(t => QUESTION_TYPES.includes(t)) || 'Long answer';
  let options = (q.options || []).map(String).filter(s => s.trim());
  if (type === 'True / False') options = ['True', 'False'];
  let correct = [...new Set((q.correct || []).map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n < options.length);
  if (CHOICE_TYPES.includes(type)) {
    if (options.length < 2 || correct.length === 0) type = 'Long answer';
    else if (type !== 'MCQ Multiple') correct = correct.slice(0, 1);
  }
  if (!CHOICE_TYPES.includes(type)) { options = []; correct = []; }
  return {
    id: String(i + 1),
    type,
    text: String(q.text || '').trim(),
    options,
    correct,
    marks: Math.min(12, Math.max(1, Math.round(Number(q.marks) || 4))),
    explanation: String(q.explanation || ''),
  };
}

async function handleGenerate(p) {
  const grade = Math.min(12, Math.max(9, Number(p.grade) || 9));
  const count = Math.min(15, Math.max(1, Number(p.count) || 5));
  const topic = String(p.prompt || '').trim();
  const isLanguage = LANGUAGE_SUBJECTS.includes(p.subject);
  const typeRule = p.qtype === 'Mixed'
    ? 'Use a varied mix of question types.'
    : `Every question must be of type "${p.qtype}".`;

  const system = `You write IB MYP practice assessments for Grade ${grade} students.

Scope: the student's topic is a hard boundary. Every question must directly test something named in the topic. Do not drift into neighbouring topics, the wider unit, or unrelated parts of any source document. If the topic is vague, stay narrow and literal.

Quality: each question is complete, self-contained, specific and different from the others. Never write placeholders like "Question 1". Match vocabulary, prior knowledge and multi-step reasoning to Grade ${grade} and the requested difficulty. Target the requested IB criterion.

Format rules:
- Write all maths, formulas, units with powers and chemical notation in LaTeX inside $...$.
- MCQ: exactly 4 plausible options, "correct" has exactly one index.
- MCQ Multiple: 4 or 5 options, "correct" has two or more indexes. Say "Select all that apply" in the text.
- True / False: a statement to judge, options ["True","False"], "correct" is [0] or [1].
- Fill in the blanks: show each blank as ____ in the text; the student types the missing words. options and correct are empty.
- Question with sub-parts: put labelled parts (a), (b), (c) on separate lines, each with its marks in brackets.
- Long answer: options and correct are empty.
- marks: 1 to 2 for choice questions, 3 to 12 for written ones, scaled to the work required.
- explanation: the worked answer or mark scheme a teacher would use to mark it.${isLanguage ? `

Language acquisition: write the questions and any texts in ${p.subjectName || p.subject}, at a level suited to the grade. There is no audio, so for Listening include a short transcript inside the question that stands in for the spoken text. For Speaking, ask the student to write what they would say.` : ''}`;

  const docs = documentsText(p.documents, 40000);
  const user = `Subject: ${p.subjectName || p.subject}
Grade: ${grade}
Criterion ${p.criterion}: ${p.criterionName}. ${p.criterionDescription || ''}
Difficulty: ${p.difficulty}
Number of questions: ${count}
Question type: ${typeRule}
Topic: ${topic || '(none given; use only the source documents)'}
Extra instructions (format and style only, they do not widen the topic): ${p.extra || 'none'}${docs ? `

Source documents. Use only the parts relevant to the topic:${docs}` : ''}`;

  const { data, model } = await callGemini({ system, user, schema: QUESTIONS_SCHEMA });
  const questions = (data.questions || [])
    .slice(0, count)
    .map((q, i) => normalizeQuestion(q, i, p.qtype))
    .filter(q => q.text.length >= 8);
  if (!questions.length) throw new HttpError('The AI returned no usable questions. Try rewording the topic.', 502);
  return json({ questions, modelUsed: model });
}

async function handleReview(p) {
  const items = (p.items || []).map(it => ({
    id: String(it.id),
    type: String(it.type || ''),
    question: String(it.question || ''),
    marks: Number(it.marks) || 1,
    markScheme: String(it.markScheme || ''),
    studentAnswer: String(it.studentAnswer || '').slice(0, 8000),
  }));
  if (!items.length) return json({ results: [] });

  const c = p.config || {};
  const system = `You mark IB MYP practice answers for Grade ${Number(c.grade) || 9} ${c.subjectName || c.subject || ''}, criterion ${c.criterion || ''} (${c.criterionName || ''}).
For each item, award a score from 0 to its marks, using the mark scheme as guidance. Give credit for valid alternative methods. Judge only what the student actually wrote. An empty answer scores 0 with result "Not answered".
feedback: one to three sentences on what was right and wrong. improvement: one concrete next step. Write maths in LaTeX inside $...$.
Return one result per item, using the same id.`;
  const docs = documentsText(p.documents, 20000);
  const user = JSON.stringify({ items }) + (docs ? `\n\nSource documents the questions were based on:${docs}` : '');

  const { data, model } = await callGemini({ system, user, schema: REVIEW_SCHEMA });
  const byId = new Map((data.results || []).map(r => [String(r.id), r]));
  const results = items.map(it => {
    const r = byId.get(it.id);
    if (!r) return { id: it.id, score: 0, result: 'Needs improvement', feedback: 'The reviewer skipped this answer. Run the review again.', improvement: '' };
    return {
      id: it.id,
      score: Math.min(it.marks, Math.max(0, Math.round(Number(r.score) * 2) / 2 || 0)),
      result: r.result,
      feedback: String(r.feedback || ''),
      improvement: String(r.improvement || ''),
    };
  });
  return json({ results, modelUsed: model });
}

export default async function handler(req) {
  const route = new URL(req.url).pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '');
  try {
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Request body was not valid JSON.' }, 400); }
    if (route === '/generate') return await handleGenerate(body);
    if (route === '/review') return await handleReview(body);
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}
