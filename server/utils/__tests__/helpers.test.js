import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { getRobotsRules } from '../helpers.js';

const createLogger = () => ({
  warn: () => {},
  info: () => {},
  error: () => {},
});

test('getRobotsRules returns permissive parser when download fails', async (t) => {
  const logger = createLogger();
  const db = {
    get: async () => null,
    run: async () => {},
  };

  t.mock.method(axios, 'get', async () => {
    throw new Error('network down');
  });

  const robots = await getRobotsRules(
    'fallback.example',
    Promise.resolve(db),
    logger
  );

  assert.ok(robots, 'robots parser should be returned');
  assert.strictEqual(robots.isAllowed('http://fallback.example/', 'MikuCrawler'), true);
});

test('getRobotsRules can surface null when allowOnFailure is false', async (t) => {
  const logger = createLogger();
  const db = {
    get: async () => null,
    run: async () => {},
  };

  t.mock.method(axios, 'get', async () => {
    throw new Error('network down');
  });

  const robots = await getRobotsRules(
    'strict.example',
    Promise.resolve(db),
    logger,
    { allowOnFailure: false }
  );

  assert.strictEqual(robots, null);
});
