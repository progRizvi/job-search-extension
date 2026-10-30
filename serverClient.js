// Talks to the local job-leads server (server/). The shared key is saved once from the popup.
const SERVER_URL = globalThis.LEAD_SERVER || 'http://127.0.0.1:3917';

class ServerDown extends Error {}

// GET when body is undefined, otherwise POST as JSON. Throws ServerDown when the server cannot be used at all.
async function serverFetch(path, body) {
  const { leadKey } = await chrome.storage.local.get('leadKey');
  if (!leadKey) throw new ServerDown('No server key saved yet.');
  let r;
  try {
    r = await fetch(SERVER_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-lead-key': leadKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServerDown('The local server is not running.');
  }
  if (r.status === 401) throw new ServerDown('The server key is wrong.');
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json();
}
