import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScutil, parseWinProxy, withProxyEnv } from './sysProxy.js';

test('macOS：优先 HTTPS 代理，没有就用 HTTP，未启用时为空', () => {
  const on = '<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7891\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n}';
  assert.equal(parseScutil(on), 'http://127.0.0.1:7891');
  assert.equal(parseScutil(on.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), 'http://127.0.0.1:7890');
  assert.equal(parseScutil('<dictionary> {\n  HTTPEnable : 0\n}'), null);
});
test('Windows：单个地址与按协议分列的地址', () => {
  const en = 'ProxyEnable    REG_DWORD    0x1';
  assert.equal(parseWinProxy(en, 'ProxyServer    REG_SZ    127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseWinProxy(en, 'ProxyServer    REG_SZ    http=a:1;https=b:2;socks=c:3'), 'http://b:2');
  assert.equal(parseWinProxy('ProxyEnable    REG_DWORD    0x0', 'ProxyServer    REG_SZ    127.0.0.1:7890'), null);
});
test('PIUPIU_PROXY 手动指定，off 表示直连；本机地址不走代理', () => {
  process.env.PIUPIU_PROXY = 'http://10.0.0.2:8080';
  const env = withProxyEnv({ A: '1' });
  assert.equal(env.HTTPS_PROXY, 'http://10.0.0.2:8080'); assert.equal(env.NODE_USE_ENV_PROXY, '1'); assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  delete process.env.PIUPIU_PROXY;
});
