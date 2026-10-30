// Optional DeepSeek helper (OpenAI-compatible API). Does nothing unless the user saved a key.
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_PROFILE =
  'Full-stack engineer with about 3 years of experience. Skills: PHP/Laravel, Node.js (NestJS, Express), ' +
  'React/Next.js, TypeScript/JavaScript, MySQL, MongoDB, REST APIs. Wants backend or full-stack roles at mid level. ' +
  'Remote roles only: on-site roles are not acceptable. ' +
  'Not interested in intern, principal/staff, manager, QA, DevOps, or Python/Java-only roles.';

// Returns the parsed JSON answer, or null when there is no key or the call failed.
async function deepseekJson(system, user, maxTokens = 300) {
  const { deepseekKey } = await chrome.storage.local.get('deepseekKey');
  if (!deepseekKey) return null;
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
      signal: AbortSignal.timeout(60000), // a stalled connection must not freeze a whole run
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${system} Reply with JSON only.` },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const msg =
        res.status === 401 ? 'DeepSeek rejected the API key.'
        : res.status === 402 ? 'DeepSeek account has no balance.'
        : `DeepSeek error ${res.status}.`;
      await chrome.storage.local.set({ deepseekError: msg });
      return null;
    }
    await chrome.storage.local.remove('deepseekError');
    const t = new Date();
    const day = `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
    const { dsStats } = await chrome.storage.local.get('dsStats');
    const count = dsStats && dsStats.day === day ? dsStats.count : 0;
    await chrome.storage.local.set({ dsStats: { day, count: count + 1 } });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}

async function getProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return profile || DEFAULT_PROFILE;
}
