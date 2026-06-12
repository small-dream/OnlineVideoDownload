'use strict';

(() => {
  if (globalThis.__OVD_SOURCE_HANDLERS__) {
    return;
  }

  const sourceUtils = globalThis.__OVD_VIDEO_SOURCE_UTILS__ || {};

  class SourceDownloadRegistry {
    constructor() {
      this.handlers = [];
      this.strategiesBySource = new Map();
    }

    registerHandler(handler) {
      if (!handler || typeof handler.supports !== 'function') {
        throw new Error('Invalid source handler');
      }

      this.handlers.push(handler);
      return this;
    }

    registerStrategy(sourceId, strategy) {
      if (!sourceId || !strategy || typeof strategy.download !== 'function') {
        throw new Error('Invalid source strategy');
      }

      const existing = this.strategiesBySource.get(sourceId) || [];
      existing.push(strategy);
      existing.sort((left, right) => (right.priority || 0) - (left.priority || 0));
      this.strategiesBySource.set(sourceId, existing);
      return this;
    }

    getHandler(videoInfo) {
      return this.handlers.find((handler) => handler.supports(videoInfo)) || null;
    }

    getStrategies(sourceId) {
      return [...(this.strategiesBySource.get(sourceId) || [])];
    }

    resolveDownload(videoInfo, context = {}) {
      const handler = this.getHandler(videoInfo);
      if (!handler) {
        return null;
      }

      const sourceId = handler.id || sourceUtils.getSourceId?.(videoInfo) || 'generic';
      const availableStrategies = this.getStrategies(sourceId)
        .filter((strategy) => (typeof strategy.supports === 'function' ? strategy.supports(videoInfo, context) : true));

      const selectedStrategy = typeof handler.selectStrategy === 'function'
        ? handler.selectStrategy(videoInfo, availableStrategies, context)
        : availableStrategies[0] || null;

      return {
        handler,
        sourceId,
        strategy: selectedStrategy || null,
        strategyId: selectedStrategy?.id || null,
      };
    }

    async download(videoInfo, context = {}) {
      const resolved = this.resolveDownload(videoInfo, context);
      if (!resolved) {
        throw new Error('No source handler available');
      }

      if (!resolved.strategy) {
        throw new Error(`No available download strategy for source: ${resolved.sourceId}`);
      }

      return resolved.strategy.download(videoInfo, {
        ...context,
        sourceId: resolved.sourceId,
        strategyId: resolved.strategyId,
        sourceHandler: resolved.handler,
      });
    }
  }

  function createSourceHandler(id) {
    return {
      id,
      supports(videoInfo) {
        return sourceUtils.getSourceId?.(videoInfo) === id;
      },
      getTaskKey(videoInfo) {
        return sourceUtils.buildTaskKey?.(videoInfo);
      },
      selectStrategy(_videoInfo, strategies) {
        return strategies[0] || null;
      },
    };
  }

  function normalizeStrategies(strategies = []) {
    return strategies
      .filter(Boolean)
      .map((strategy, index) => ({
        priority: 0,
        id: `strategy-${index}`,
        ...strategy,
      }));
  }

  function createDefaultSourceRegistry(options = {}) {
    const registry = new SourceDownloadRegistry();
    const strategyConfig = options.strategies || {};

    registry
      .registerHandler(createSourceHandler('blob'))
      .registerHandler(createSourceHandler('youtube'))
      .registerHandler(createSourceHandler('bilibili'))
      .registerHandler(createSourceHandler('dash'))
      .registerHandler({
        id: 'generic',
        supports() {
          return true;
        },
        getTaskKey(videoInfo) {
          return sourceUtils.buildTaskKey?.(videoInfo);
        },
        selectStrategy(_videoInfo, strategies) {
          return strategies[0] || null;
        },
      });

    for (const [sourceId, strategies] of Object.entries(strategyConfig)) {
      for (const strategy of normalizeStrategies(strategies)) {
        registry.registerStrategy(sourceId, strategy);
      }
    }

    return registry;
  }

  globalThis.__OVD_SOURCE_HANDLERS__ = {
    SourceDownloadRegistry,
    createDefaultSourceRegistry,
  };
})();
