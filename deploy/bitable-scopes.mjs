import {withWikiFileScopes} from './wiki-file-scopes.mjs';

// Official per-operation scopes, including v2 roles (broad bitable:app alone is insufficient).
export const bitableScopes = [
  'base:app:create','base:app:read','base:app:update',
  'base:table:read','base:table:create','base:table:update','base:table:delete',
  'base:field:read','base:field:create','base:field:update','base:field:delete',
  'base:record:retrieve','base:record:read','base:record:create','base:record:update','base:record:delete',
  'base:view:read','base:view:write_only',
  'base:role:read','base:role:create','base:role:update','base:role:delete',
  'base:collaborator:read','base:collaborator:create','base:collaborator:delete',
  'base:dashboard:read','base:dashboard:copy','base:workflow:read','base:workflow:write',
  'docs:document.media:upload'
];
export function withBitableScopes(contents,currentScopes) {
  return withWikiFileScopes(contents,currentScopes+' '+bitableScopes.join(' '));
}
