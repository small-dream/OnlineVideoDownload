'use strict';

(() => {
  if (globalThis.__OVD_BYTE_UTILS__) {
    return;
  }

  /**
   * 将 Uint8Array 编码为 Base64 字符串
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function uint8ArrayToBase64(bytes) {
    let binary = '';
    const step = 0x8000;

    for (let i = 0; i < bytes.length; i += step) {
      const slice = bytes.subarray(i, i + step);
      binary += String.fromCharCode(...slice);
    }

    return btoa(binary);
  }

  /**
   * 将 Base64 字符串解码为 Uint8Array
   * @param {string} base64
   * @returns {Uint8Array}
   */
  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  /**
   * 将字节数格式化为可读字符串
   * @param {number} bytes
   * @param {object} [options]
   * @param {boolean} [options.alwaysShowUnit] - 为 0 时也显示单位
   * @returns {string}
   */
  function formatBytes(bytes, options = {}) {
    const value = Number(bytes) || 0;
    if (!value && !options.alwaysShowUnit) {
      return '';
    }
    if (!value) {
      return '0 B';
    }
    if (value >= 1024 * 1024 * 1024) {
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }
    if (value >= 1024 * 1024) {
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }
    if (value >= 1024) {
      return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${value} B`;
  }

  /**
   * 拼接多个 Uint8Array 为一个
   * @param {Uint8Array[]} arrays
   * @returns {Uint8Array}
   */
  /**
   * 顺序拼接分片。
   * @param {Uint8Array[]} arrays
   * @param {number} [totalBytes=0] - 已知总长度时预分配，避免二次遍历
   */
  function concatUint8Arrays(arrays, totalBytes = 0) {
    const total = Number(totalBytes) > 0
      ? Number(totalBytes)
      : arrays.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
    const output = new Uint8Array(total);
    let offset = 0;

    for (const chunk of arrays) {
      if (!chunk?.length) {
        continue;
      }
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return output;
  }

  globalThis.__OVD_BYTE_UTILS__ = Object.freeze({
    base64ToUint8Array,
    concatUint8Arrays,
    formatBytes,
    uint8ArrayToBase64,
  });
})();
