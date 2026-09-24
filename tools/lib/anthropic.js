'use strict';
/* One Messages API call that must come back as one tool answer. Same request as the menu
   import (tools/import-menu.js): x-api-key, anthropic-version 2023-06-01, a document block
   for a PDF, image blocks for photos. ANTHROPIC_BASE_URL replaces the endpoint (tests).

   Replay: with a fixture path the saved response body (a Messages API response, as JSON)
   is read instead of calling the API, and goes through the same checks. */
const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MEDIA = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 30 * 1024 * 1024;   // the API refuses requests over 32 MB; base64 adds a third

function fileBlocks(files, cwd) {
  let total = 0;
  return files.map(function (f) {
    const p = path.resolve(cwd || process.cwd(), f);
    const type = MEDIA[path.extname(p).toLowerCase()];
    if (!type) throw new Error(f + ' is not a PDF or a photo (jpg, png, webp, gif).');
    if (!fs.existsSync(p)) throw new Error(f + ' does not exist.');
    const data = fs.readFileSync(p);
    total += data.length;
    if (total > MAX_BYTES) throw new Error('The menu files are over 30 MB together; send fewer or smaller files.');
    return { type: type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: type, data: data.toString('base64') } };
  });
}

/* The request, as tools/import-menu.js requestBatch builds it: the tool is forced for every
   model; strict is sent only when asked for (--strict) and output_config only with --effort.
   A 400 that names one of them is answered by the loop in callTool below. */
function buildRequest(o, c) {
  c = c || { forced: true, strict: !!o.strict, effort: o.effort || null };
  const tool = Object.assign({}, o.tool);
  if (c.strict) tool.strict = true;
  const body = {
    model: o.model || DEFAULT_MODEL,
    max_tokens: o.maxTokens || 16000,
    system: o.system,
    tools: [tool],
    tool_choice: c.forced ? { type: 'tool', name: o.tool.name } : { type: 'auto' },
    messages: [{ role: 'user', content: (o.blocks || []).concat([{ type: 'text', text: o.prompt + (c.forced ? '' : '\nAnswer only by calling the ' + o.tool.name + ' tool.') }]) }]
  };
  if (c.effort) body.output_config = { effort: c.effort };
  return body;
}

function toolInput(body, name) {
  if (!body || typeof body !== 'object') throw new Error('The model answer was not JSON.');
  if (body.type === 'error' || body.error) throw new Error('The model API refused the request: ' + ((body.error && body.error.message) || 'unknown error') + '.');
  if (body.stop_reason === 'refusal') throw new Error('The model declined this request (refusal). Set the values by hand with the override flags.');
  const hit = (body.content || []).filter(function (b) { return b && b.type === 'tool_use' && b.name === name; })[0];
  if (!hit || !hit.input || typeof hit.input !== 'object') {
    throw new Error('The model did not answer with the ' + name + ' tool (stop reason ' + (body.stop_reason || 'unknown') + ').');
  }
  return hit.input;
}

async function callTool(o) {
  if (o.fixture) {
    if (!fs.existsSync(o.fixture)) throw new Error('Fixture ' + o.fixture + ' does not exist.');
    return toolInput(JSON.parse(fs.readFileSync(o.fixture, 'utf8')), o.tool.name);
  }
  const env = o.env || process.env;
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const doFetch = o.fetch || globalThis.fetch;
  const log = typeof o.log === 'function' ? o.log : function () {};
  const model = o.model || DEFAULT_MODEL;
  const c = { forced: true, strict: !!o.strict, effort: o.effort || null };
  let noCallRetries = 1;
  for (;;) {
    let res;
    try {
      res = await doFetch(base + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(buildRequest(o, c))
      });
    } catch (e) {
      throw new Error('Could not reach the model API (' + (e.cause && e.cause.code || e.message) + ').');
    }
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { throw new Error('The model API answered HTTP ' + res.status + ' without JSON.'); }
    if (!res.ok) {
      const bad = res.status === 400 ? ((body.error && body.error.message) || '') : '';
      // each refused field is dropped once, with one line of log (tools/import-menu.js does the same)
      if (c.forced && /tool_choice/i.test(bad)) { c.forced = false; log(model + ' refuses a forced tool_choice; using auto with an instruction'); continue; }
      if (c.strict && /strict/i.test(bad)) { c.strict = false; log(model + ' refuses strict tool use; sending the tool without strict'); continue; }
      if (c.effort && /output_config|effort/i.test(bad)) { c.effort = null; log(model + ' refuses output_config; sending no effort'); continue; }
      throw new Error('The model API refused the request: ' + ((body.error && body.error.message) || 'HTTP ' + res.status) + '.');
    }
    const call = (body.content || []).some(function (b) { return b && b.type === 'tool_use' && b.name === o.tool.name; });
    if (!call && !c.forced && body.stop_reason === 'end_turn' && noCallRetries-- > 0) { log('no tool call in the answer, asking again'); continue; }
    return toolInput(body, o.tool.name);
  }
}

module.exports = { callTool, buildRequest, fileBlocks, toolInput, DEFAULT_MODEL };
