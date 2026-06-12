'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadSourceHandlers() {
  delete globalThis.__OVD_VIDEO_SOURCE_UTILS__;
  delete globalThis.__OVD_SOURCE_HANDLERS__;

  const sourceUtilsPath = path.resolve(__dirname, '../lib/video-source-utils.js');
  const sourceHandlersPath = path.resolve(__dirname, '../content/source-handlers.js');

  delete require.cache[sourceUtilsPath];
  delete require.cache[sourceHandlersPath];

  require(sourceUtilsPath);
  require(sourceHandlersPath);

  return globalThis.__OVD_SOURCE_HANDLERS__;
}

test('SourceDownloadRegistry constructor', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  assert.ok(Array.isArray(registry.handlers));
  assert.equal(registry.handlers.length, 0);
  assert.ok(registry.strategiesBySource instanceof Map);
});

test('registerHandler: valid handler chains and returns this', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();
  const handler = { supports: () => true, id: 'test' };

  const result = registry.registerHandler(handler);
  assert.equal(result, registry, 'should return this for chaining');
  assert.equal(registry.handlers.length, 1);
  assert.equal(registry.handlers[0], handler);
});

test('registerHandler: invalid handler (no supports) throws', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  assert.throws(() => registry.registerHandler({}), /Invalid source handler/);
  assert.throws(() => registry.registerHandler(null), /Invalid source handler/);
  assert.throws(() => registry.registerHandler({ supports: 'not-a-function' }), /Invalid source handler/);
});

test('registerStrategy: sorts by priority descending', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  const lowPriority = { priority: 1, download: async () => {}, id: 'low' };
  const highPriority = { priority: 10, download: async () => {}, id: 'high' };
  const medPriority = { priority: 5, download: async () => {}, id: 'med' };

  registry
    .registerStrategy('youtube', lowPriority)
    .registerStrategy('youtube', highPriority)
    .registerStrategy('youtube', medPriority);

  const strategies = registry.getStrategies('youtube');
  assert.equal(strategies.length, 3);
  assert.equal(strategies[0].id, 'high');
  assert.equal(strategies[1].id, 'med');
  assert.equal(strategies[2].id, 'low');
});

test('registerStrategy: invalid throws', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  assert.throws(() => registry.registerStrategy('', { download: async () => {} }), /Invalid/);
  assert.throws(() => registry.registerStrategy('youtube', null), /Invalid/);
  assert.throws(() => registry.registerStrategy('youtube', { priority: 1 }), /Invalid/);
});

test('registerStrategy returns this for chaining', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  const result = registry.registerStrategy('youtube', { download: async () => {} });
  assert.equal(result, registry);
});

test('getHandler: first match wins', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  const handler1 = { supports: () => true, id: 'first' };
  const handler2 = { supports: () => true, id: 'second' };

  registry.registerHandler(handler1).registerHandler(handler2);

  const found = registry.getHandler({});
  assert.equal(found.id, 'first');
});

test('getHandler: returns null when no match', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  registry.registerHandler({ supports: () => false, id: 'never' });

  assert.equal(registry.getHandler({}), null);
});

test('getStrategies: returns copy, empty for unknown sourceId', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  registry.registerStrategy('youtube', { download: async () => {} });

  const strategies = registry.getStrategies('youtube');
  const unknown = registry.getStrategies('unknown');

  assert.ok(Array.isArray(strategies));
  assert.equal(strategies.length, 1);
  assert.notEqual(strategies, registry.strategiesBySource.get('youtube'), 'should be a copy');
  assert.deepEqual(unknown, []);
});

test('resolveDownload: handler -> sourceId -> filter strategies -> selectStrategy', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  const handler = {
    id: 'youtube',
    supports: (vi) => vi.type === 'youtube-adaptive',
    selectStrategy: (_vi, strategies) => strategies[0] || null,
  };

  const strategy = { id: 'capture', download: async () => 'result', priority: 10 };

  registry.registerHandler(handler).registerStrategy('youtube', strategy);

  const resolved = registry.resolveDownload({ type: 'youtube-adaptive' });
  assert.ok(resolved);
  assert.equal(resolved.handler, handler);
  assert.equal(resolved.sourceId, 'youtube');
  assert.equal(resolved.strategy, strategy);
  assert.equal(resolved.strategyId, 'capture');
});

test('resolveDownload: filters strategies via supports()', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  const handler = {
    id: 'youtube',
    supports: () => true,
    selectStrategy: (_vi, strategies) => strategies[0] || null,
  };

  const alwaysStrategy = { id: 'always', download: async () => {}, priority: 10, supports: () => true };
  const neverStrategy = { id: 'never', download: async () => {}, priority: 20, supports: () => false };

  registry.registerHandler(handler);
  registry.registerStrategy('youtube', neverStrategy);
  registry.registerStrategy('youtube', alwaysStrategy);

  const resolved = registry.resolveDownload({});
  assert.ok(resolved.strategy);
  assert.equal(resolved.strategyId, 'always');
});

test('resolveDownload: returns null when no handler matches', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  registry.registerHandler({ supports: () => false, id: 'never' });

  assert.equal(registry.resolveDownload({}), null);
});

test('resolveDownload: strategy is null when no strategies available', () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  registry.registerHandler({ id: 'youtube', supports: () => true });

  const resolved = registry.resolveDownload({});
  assert.ok(resolved);
  assert.equal(resolved.strategy, null);
  assert.equal(resolved.strategyId, null);
});

test('download: delegates to strategy.download()', async () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  let downloadArgs = null;
  const handler = {
    id: 'youtube',
    supports: () => true,
    selectStrategy: (_vi, strategies) => strategies[0] || null,
  };
  const strategy = {
    id: 's1',
    priority: 10,
    download: async (videoInfo, context) => {
      downloadArgs = { videoInfo, context };
      return { success: true };
    },
  };

  registry.registerHandler(handler).registerStrategy('youtube', strategy);

  const result = await registry.download({ url: 'https://youtube.com/watch?v=abc' }, { tabId: 1 });
  assert.deepEqual(result, { success: true });
  assert.ok(downloadArgs);
  assert.equal(downloadArgs.context.sourceId, 'youtube');
  assert.equal(downloadArgs.context.strategyId, 's1');
  assert.equal(downloadArgs.context.sourceHandler, handler);
});

test('download: throws if no handler available', async () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  await assert.rejects(
    () => registry.download({}),
    /No source handler available/,
  );
});

test('download: throws if no strategy available', async () => {
  const { SourceDownloadRegistry } = loadSourceHandlers();
  const registry = new SourceDownloadRegistry();

  registry.registerHandler({ id: 'youtube', supports: () => true });

  await assert.rejects(
    () => registry.download({}),
    /No available download strategy for source: youtube/,
  );
});

test('createDefaultSourceRegistry: creates with blob/youtube/bilibili/dash/generic handlers', () => {
  const { createDefaultSourceRegistry } = loadSourceHandlers();
  const registry = createDefaultSourceRegistry();

  assert.equal(registry.handlers.length, 5);

  // Test handler matching for each source type
  assert.equal(registry.getHandler({ type: 'blob' })?.id, 'blob');
  assert.equal(registry.getHandler({ type: 'youtube-adaptive' })?.id, 'youtube');
  assert.equal(registry.getHandler({ type: 'bilibili-meta' })?.id, 'bilibili');
  assert.equal(registry.getHandler({ type: 'bilibili-dash' })?.id, 'bilibili');
  assert.equal(registry.getHandler({ type: 'dash' })?.id, 'dash');
  assert.equal(registry.getHandler({ type: 'unknown' })?.id, 'generic');
});

test('createDefaultSourceRegistry: registers provided strategies', () => {
  const { createDefaultSourceRegistry } = loadSourceHandlers();

  const mockStrategy = { download: async () => 'blob-result' };
  const registry = createDefaultSourceRegistry({
    strategies: {
      blob: [mockStrategy],
    },
  });

  const strategies = registry.getStrategies('blob');
  assert.equal(strategies.length, 1);
  assert.equal(strategies[0].download, mockStrategy.download);
  assert.equal(strategies[0].priority, 0, 'default priority should be 0');
});

test('createDefaultSourceRegistry: normalizes multiple strategies with default priority', () => {
  const { createDefaultSourceRegistry } = loadSourceHandlers();

  const registry = createDefaultSourceRegistry({
    strategies: {
      youtube: [
        { download: async () => {}, priority: 5, id: 'custom-1' },
        { download: async () => {} },
      ],
    },
  });

  const strategies = registry.getStrategies('youtube');
  assert.equal(strategies.length, 2);
  assert.equal(strategies[0].id, 'custom-1');
  assert.equal(strategies[0].priority, 5);
  assert.equal(strategies[1].priority, 0);
  assert.ok(strategies[1].id.startsWith('strategy-'));
});
