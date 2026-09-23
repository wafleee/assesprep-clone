import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const DEFAULT_ENDPOINT = process.env.GEMINI_API_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta';
const STORE = getStore({ name: 'assessment-studio-config', consistency: 'strong' });
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function timingSafeEqualStrings(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function signToken(exp) {
  const secret = process.env.ADMIN_PASSWORD || '';
  return crypto.createHmac('sha256', secret).update(`assessment-admin:${exp}`).digest('base64url');
}

function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}.${signToken(exp)}`;
}

function validToken(req) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || Date.now() > exp || !sig) return false;
  return timingSafeEqualStrings(sig, signToken(exp));
}

async function readStoredConfig() {
  try {
    const saved = await STORE.get('global-config', { type: 'json', consistency: 'strong' });
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

async function getConfig() {
  const saved = await readStoredConfig();
  return {
    enabled: saved.enabled !== undefined ? !!saved.enabled : process.env.ASSESSMENT_AI_ENABLED !== 'false',
    provider: 'gemini',
    endpoint: DEFAULT_ENDPOINT,
    model: saved.model || DEFAULT_MODEL,
    apiKey: process.env.GEMINI_API_KEY || '',
  };
}

async function parseBody(req) {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error('Request body was not valid JSON.'); }
}

function stripCodeFence(s) {
  return String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseJsonObject(s) {
  const clean = stripCodeFence(s);
  try { return JSON.parse(clean); } catch {}
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(clean.slice(a, b + 1));
  throw new Error('AI response was not valid JSON.');
}

class GeminiTemporaryError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'GeminiTemporaryError';
    this.status = status;
  }
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(8000, Math.max(500, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(8000, Math.max(500, date - Date.now()));
  }
  return Math.min(8000, 1500 * (2 ** attempt));
}

async function callGemini(messages, config) {
  if (!config.enabled) throw new Error('Global AI generation is disabled in the admin panel.');
  if (!config.apiKey) throw new Error('Gemini is not configured. Ask the administrator to set GEMINI_API_KEY in Netlify.');

  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    });
  }
  const systemInstruction = messages.find(m => m.role === 'system')?.content || '';
  const requestBody = { contents };
  if (systemInstruction) requestBody.systemInstruction = { parts: [{ text: String(systemInstruction) }] };

  const endpoint = `${config.endpoint.replace(/\/$/, '')}/models/${encodeURIComponent(config.model)}:generateContent`;
  const maxAttempts = 4;
  let lastStatus = 503;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let r;
    try {
      r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      // Network failures are also temporary; retry them with the same backoff.
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs({ headers: { get: () => null } }, attempt)));
        continue;
      }
      throw new GeminiTemporaryError('Gemini could not be reached right now. Please try starting the test again in a moment.', 503);
    }

    lastStatus = r.status;
    const txt = await r.text();

    if (r.ok) {
      let data;
      try { data = JSON.parse(txt); } catch { throw new Error('Gemini returned non-JSON data.'); }
      const content = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (!content) {
        throw new Error(data?.promptFeedback?.blockReason
          ? `Gemini blocked the request: ${data.promptFeedback.blockReason}`
          : 'Gemini returned no text.');
      }
      return content;
    }

    if ((r.status === 503 || r.status === 429) && attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(r, attempt)));
      continue;
    }

    if (r.status === 503) {
      throw new GeminiTemporaryError('Gemini is temporarily busy. We retried automatically, but it is still unavailable. Please try starting the test again in a moment.', 503);
    }
    if (r.status === 429) {
      throw new GeminiTemporaryError('Gemini request limits have temporarily been reached. We retried automatically, but the service is still limiting requests. Please try again in a moment.', 429);
    }

    // Avoid exposing Google's full error payload to students for non-retryable failures.
    if (r.status === 400) throw new Error('Gemini rejected the request. Check the topic, model, or AI configuration.');
    if (r.status === 401 || r.status === 403) throw new Error('The Gemini API key is invalid or does not have access to the selected model. Ask the administrator to check the API configuration.');
    throw new Error(`Gemini returned HTTP ${lastStatus}. Please try again.`);
  }

  throw new GeminiTemporaryError('Gemini is temporarily unavailable. Please try again in a moment.', 503);
}

async function handleGenerate(req) {
  const p = await parseBody(req);
  const config = await getConfig();
  const docs = (p.documents || []).map(d => `\nDOCUMENT ${d.name}:\n${String(d.text || '').slice(0, 50000)}`).join('');
  const grade = Math.min(12, Math.max(9, Number(p.grade) || 9));
  const topic = String(p.prompt || '').trim();
  const system = `You are an expert IB MYP assessment author. The student's TOPIC / REQUEST is a HARD SCOPE BOUNDARY, not a suggestion. Generate genuinely NEW, specific questions that stay directly and narrowly within that topic. Never broaden the topic into the rest of the subject, chapter, unit, criterion, or document unless the student explicitly asks for that broader material. Never use placeholders such as "Question 1", "Question 2", "a question about...", or generic instructions. Each item must be a complete question that could be given to a student immediately.

TOPIC LOCK RULES (CRITICAL):
1. Treat the exact TOPIC / REQUEST supplied by the user as the only content scope for the questions.
2. Before writing questions, silently identify the concrete concepts, terms, processes, examples, and constraints explicitly present in the topic. Use those as the topic anchors.
3. Every question must directly test at least one of those anchors and must not rely on an unrelated concept.
4. Do NOT turn a narrow topic into a general subject test. Do NOT add adjacent or commonly related topics unless the user explicitly included them.
5. If the topic contains multiple concepts joined by words such as "and", cover those requested concepts; do not replace them with a broader unit.
6. If the topic is vague, stay literal and make the questions narrower around the words the user actually supplied rather than guessing a larger curriculum topic.
7. SOURCE DOCUMENTS are reference material only. Use only the portions relevant to the requested topic. A document does NOT authorize questions on unrelated material.
8. ADDITIONAL INSTRUCTIONS may change question format or style, but must not expand the content scope unless the user explicitly says so.
9. Silently perform a final topic-scope check on every question before returning it. Remove or rewrite any question that could reasonably be described as mainly testing a different topic.

Base the content tightly on the requested SUBJECT, TOPIC, GRADE, CRITERION and difficulty, with the TOPIC taking priority for content scope.

GRADE CALIBRATION IS CRITICAL: Every question must be appropriate for Grade ${grade}. Match expected prior knowledge, vocabulary, reading level, mathematical/scientific complexity, abstraction, multi-step reasoning, and scaffolding to Grade ${grade}. Grade 9 should use age-appropriate concepts and a lower level of prerequisite knowledge than Grades 10–12; Grade 12 may require the most advanced reasoning and synthesis of the four levels. Do not introduce concepts normally beyond the selected grade unless the student's topic explicitly requires them. Within the selected grade, still follow the requested difficulty setting.

Return ONLY valid JSON in this exact shape: {"questions":[{"id":"1","type":"Long answer|MCQ|MCQ Multiple|True / False|Fill in the blanks|Question with sub-parts","text":"complete student-facing question","options":["option 1","option 2","option 3","option 4"],"answer":0,"marks":6,"criterion":"${p.criterion}","criterionName":"${p.criterionName}","explanation":"brief reasoning for the correct answer or marking focus"}]}

Requirements: ${p.allowMCQ ? 'MCQs are permitted when the requested question type uses them; otherwise follow the requested type exactly.' : 'Do not use MCQs.'} For MCQ provide exactly 4 plausible options and one correct answer. For MCQ Multiple provide 4 or 5 plausible options and an array of correct option indices. For True / False provide two options or omit options and use answer 0/1. For long-answer or sub-part questions, do not include a student answer, but include an explanation describing the expected reasoning. Avoid repeating scenarios or wording. Make every question materially different.

TOPIC SCOPE REMINDER: The generated questions must stay inside this exact user request: ${topic || '(no topic supplied; use the smallest reasonable scope from the other fields, but do not create a broad subject test)'}`;
  const user = `SUBJECT: ${p.subject}
GRADE: ${grade}
IB CRITERION: ${p.criterion} — ${p.criterionName}
CRITERION DESCRIPTION: ${p.criterionDescription || ''}
QUESTION TYPE: ${p.qtype}
DIFFICULTY: ${p.difficulty}
NUMBER OF QUESTIONS: ${p.count}
TOPIC / REQUEST (HARD CONTENT SCOPE): ${topic || '(none supplied)'}
ADDITIONAL INSTRUCTIONS: ${p.extra || 'None'}
SOURCE DOCUMENTS (USE ONLY RELEVANT SECTIONS):${docs || ' None'}

FINAL INSTRUCTION: Do not generate questions merely because they are related to the subject, criterion, or source document. Every question must be directly answerable from and focused on the specific topic/request above.`;
  const content = await callGemini([{ role: 'system', content: system }, { role: 'user', content: user }], config);
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) throw new Error('AI returned no questions.');
  return json({ questions: parsed.questions.slice(0, Math.max(1, Number(p.count) || 5)) });
}

async function handleReview(req) {
  const p = await parseBody(req);
  const config = await getConfig();
  const system = `You are an objective IB MYP assessment reviewer. Review each student's response against the exact generated question and criterion. Return ONLY valid JSON: {"results":[{"score":0,"feedback":"specific feedback","result":"Correct|Partially correct|Needs improvement|Not answered","improvement":"specific next step"}]}. Award an integer or sensible decimal score from 0 to that question's marks. For MCQs use the stored answer key. For written responses, judge the actual content, reasoning, evidence, calculations and criterion alignment. Do not invent what the student wrote.`;
  const content = await callGemini([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ config: p.config, questions: p.questions, answers: p.answers, documents: p.documents }) }], config);
  const parsed = parseJsonObject(content);
  if (!Array.isArray(parsed.results)) throw new Error('AI reviewer returned no results.');
  return json({ results: parsed.results });
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    let route = url.pathname;
    const functionPrefix = '/.netlify/functions/api';
    if (route === functionPrefix) route = '/';
    else if (route.startsWith(functionPrefix + '/')) route = route.slice(functionPrefix.length);
    else if (route.startsWith('/api/')) route = route.slice(4);

    if (req.method === 'GET' && route === '/config') {
      const c = await getConfig();
      return json({ configured: !!c.apiKey, enabled: !!c.enabled, provider: 'gemini', model: c.model, config: !!c.apiKey && !!c.enabled });
    }

    if (req.method === 'POST' && route === '/admin/login') {
      if (!process.env.ADMIN_PASSWORD) return json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD in Netlify Environment Variables.' }, 503);
      const b = await parseBody(req);
      if (!timingSafeEqualStrings(String(b.password || ''), process.env.ADMIN_PASSWORD)) return json({ error: 'Invalid admin password' }, 401);
      const c = await getConfig();
      return json({ token: issueToken(), config: { provider: 'gemini', model: c.model, endpoint: c.endpoint, enabled: c.enabled, hasKey: !!c.apiKey } });
    }

    if (req.method === 'POST' && route === '/admin/logout') return json({ ok: true });

    if (req.method === 'GET' && route === '/admin/config') {
      if (!validToken(req)) return json({ error: 'Unauthorized' }, 401);
      const c = await getConfig();
      return json({ provider: 'gemini', model: c.model, endpoint: c.endpoint, enabled: c.enabled, hasKey: !!c.apiKey });
    }

    if (req.method === 'POST' && route === '/admin/config') {
      if (!validToken(req)) return json({ error: 'Unauthorized' }, 401);
      const b = await parseBody(req);
      const current = await getConfig();
      const model = String(b.model || current.model || DEFAULT_MODEL).trim().slice(0, 120) || DEFAULT_MODEL;
      const enabled = b.enabled !== false;
      await STORE.setJSON('global-config', { model, enabled });
      const c = await getConfig();
      return json({ provider: 'gemini', model: c.model, endpoint: c.endpoint, enabled: c.enabled, hasKey: !!c.apiKey });
    }

    if (req.method === 'POST' && route === '/generate') return await handleGenerate(req);
    if (req.method === 'POST' && route === '/review') return await handleReview(req);

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    const status = Number(e?.status) || 500;
    return json({ error: e?.message || String(e) }, status);
  }
}
