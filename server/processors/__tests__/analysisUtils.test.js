import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContent, processJSON } from '../analysisUtils.js';

test('analyzeContent produces keyword and sentiment insights', () => {
  const sample = 'This article is amazing and wonderful. I love the great insights it provides.';
  const analysis = analyzeContent(sample);

  assert.strictEqual(analysis.sentiment, 'positive');
  assert.ok(analysis.wordCount > 0);
  assert.ok(Array.isArray(analysis.keywords));
  assert.ok(analysis.keywords.length > 0);
});

test('processJSON parses valid payloads', () => {
  const payload = '{"items":[{"name":"miku"},{"name":"rin"}] }';
  const result = processJSON(payload);

  assert.strictEqual(result.type, 'json');
  assert.strictEqual(result.keys.includes('items'), true);
  assert.strictEqual(result.structure.type, 'object');
});

test('processJSON reports invalid payloads', () => {
  const result = processJSON('{not-valid');
  assert.strictEqual(result.type, 'json');
  assert.strictEqual(result.error, 'Invalid JSON');
});
