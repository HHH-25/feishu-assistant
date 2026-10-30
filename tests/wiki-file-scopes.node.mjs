import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import {withWikiFileScopes} from '../deploy/wiki-file-scopes.mjs';
import {withBitableScopes,bitableScopes} from '../deploy/bitable-scopes.mjs';

test('combined scope upgrade preserves existing scopes, supplies granular v2 roles and stays idempotent',()=>{
  const input='FEISHU_APP_SECRET="fixture-only"\nOTHER=keep\nMCP_FEISHU_SCOPES="offline_access wiki:wiki bitable:app"\n';
  const output=withBitableScopes(input,'offline_access wiki:wiki bitable:app'),p=dotenv.parse(output);
  assert.equal(p.FEISHU_APP_SECRET,'fixture-only');assert.equal(p.OTHER,'keep');
  const scopes=p.MCP_FEISHU_SCOPES.split(' ');
  for(const s of ['offline_access','wiki:wiki','bitable:app','drive:file:upload','drive:drive.metadata:readonly',...bitableScopes])assert.ok(scopes.includes(s),s);
  assert.equal(new Set(scopes).size,scopes.length);
  assert.equal(withBitableScopes(output,p.MCP_FEISHU_SCOPES),output);
  assert.throws(()=>withBitableScopes('MCP_FEISHU_SCOPES=a\nMCP_FEISHU_SCOPES=b','b'));
});
test('deployment scope upgrade preserves permissions and unrelated values and is repeatable',()=>{
  const old='FEISHU_APP_SECRET="fixture-only"\r\nMCP_FEISHU_SCOPES="offline_access wiki:wiki custom:read"\r\nOTHER=keep\r\n';
  const output=withWikiFileScopes(old,'offline_access wiki:wiki custom:read');
  const parsed=dotenv.parse(output);assert.equal(parsed.FEISHU_APP_SECRET,'fixture-only');assert.equal(parsed.OTHER,'keep');
  assert.equal(parsed.MCP_FEISHU_SCOPES,'offline_access wiki:wiki custom:read drive:drive.metadata:readonly drive:file:upload');
  assert.equal(withWikiFileScopes(output,parsed.MCP_FEISHU_SCOPES),output);
  assert.equal(dotenv.parse(withWikiFileScopes('OTHER=keep','drive:drive')).MCP_FEISHU_SCOPES,'drive:drive');
  assert.equal(dotenv.parse(withWikiFileScopes('','drive:file')).MCP_FEISHU_SCOPES,'drive:file drive:drive.metadata:readonly');
  assert.throws(()=>withWikiFileScopes('MCP_FEISHU_SCOPES="first\nsecond"','first second'));
  assert.throws(()=>withWikiFileScopes('MCP_FEISHU_SCOPES=a\nMCP_FEISHU_SCOPES=b','b'));
  assert.throws(()=>withWikiFileScopes('','scope" injection'));
});
