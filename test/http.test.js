/**
 * 出网层的离线测试：挑战页识别，以及 **web 兜底通道**的三种结局
 * （截断 / 非 2xx / 正常 JSON）。
 *
 * 这里不联网：`fetchImpl` 与 `getWeb` 都是注入的替身。
 *
 * @module dsh-ck3-wiki/test/http
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchJson, isChallengeResponse, jsonFromWebFetch } from '../lib/http.js';

/** 造一个总是抛网络错误的 `fetchImpl`。 */
function failingFetch() {
  return async () => {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  };
}

/** 造一个返回固定结果的 DSH `web` 服务替身。 */
function webReturning(result) {
  return () => ({ fetch: async () => result });
}

test('isChallengeResponse：HTTP 200 的 HTML 挑战页能被认出来', () => {
  const html = { headers: { get: () => 'text/html; charset=utf-8' } };
  assert.equal(isChallengeResponse(html, '<!DOCTYPE html><html><body>_fs-ch-1T1wms</body></html>'), true);
  assert.equal(isChallengeResponse(html, '<html><body>正常页面</body></html>'), true);
  const json = { headers: { get: () => 'application/json' } };
  assert.equal(isChallengeResponse(json, '{"query":{}}'), false);
});

test('jsonFromWebFetch：只解 JSON，坏内容返回 undefined', () => {
  assert.deepEqual(jsonFromWebFetch({ statusCode: 200, body: { content: '{"a":1}' } }), { status: 200, data: { a: 1 } });
  assert.equal(jsonFromWebFetch({ statusCode: 200, body: { content: '<html>' } }), undefined);
  assert.equal(jsonFromWebFetch({}), undefined);
});

test('web 兜底：truncated 的响应不当成功（即使内容像 JSON）', async () => {
  const result = await fetchJson('https://example.org/api.php', {
    fetchImpl: failingFetch(),
    retries: 0,
    getWeb: webReturning({ statusCode: 200, truncated: true, body: { content: '{"query":{"pages":[]}}' } }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('截断'), result.error);
  assert.equal(result.via, 'dsh-web');
});

test('web 兜底：非 2xx 的 JSON 不当成功', async () => {
  const result = await fetchJson('https://example.org/api.php', {
    fetchImpl: failingFetch(),
    retries: 0,
    getWeb: webReturning({ statusCode: 503, body: { content: '{"error":"down"}' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.ok(result.error.includes('503'), result.error);
  assert.ok(result.error.includes('wiki 侧暂时不可用'), result.error);
  assert.equal(result.via, 'dsh-web');
});

test('web 兜底：2xx 的 JSON 正常返回并标明通道', async () => {
  const result = await fetchJson('https://example.org/api.php', {
    fetchImpl: failingFetch(),
    retries: 0,
    getWeb: webReturning({ statusCode: 200, body: { content: '{"query":{"pages":[]}}' } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'dsh-web');
  assert.deepEqual(result.data, { query: { pages: [] } });
});
