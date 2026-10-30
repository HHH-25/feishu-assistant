/** Narrow Wiki API adapter; no arbitrary URL, document or space writes exposed to employees. */
export interface WikiNode {
  node_token: string; obj_token: string; obj_type: string; space_id: string;
  node_type?: string; title: string; parent_node_token?: string;
}
export type WikiDocumentType = 'doc'|'docx'|'sheet'|'bitable'|'mindnote'|'file'|'slides';
export interface WikiGateway {
  node(token: string): Promise<WikiNode>;
  list(space: string, parent: string, cursor?: string): Promise<{ items: WikiNode[]; next?: string }>;
  create(space: string, parent: string, title: string): Promise<WikiNode>;
  append(document: string, content: string): Promise<void>;
  read(document: string): Promise<string>;
  move(space: string, parent: string, file: string, type?:WikiDocumentType): Promise<{ wiki_token?: string; task_id?: string }>;
  task(id: string): Promise<WikiNode | null>;
}
type Api = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
const enc = encodeURIComponent;
function validNode(value: unknown): WikiNode {
  const node = value as WikiNode | undefined;
  if (!node?.node_token || !node.obj_token || !node.space_id || !node.obj_type) {
    throw new Error('飞书知识库返回节点不完整');
  }
  return node;
}
export class FeishuWikiClient implements WikiGateway {
  constructor(private api: Api) {}
  async node(token: string): Promise<WikiNode> {
    return validNode((await this.api('GET', `/wiki/v2/spaces/get_node?token=${enc(token)}`)).node);
  }
  async list(space: string, parent: string, cursor?: string) {
    const query = new URLSearchParams({ page_size: '50' });
    if (parent) query.set('parent_node_token', parent);
    if (cursor) query.set('page_token', cursor);
    const data = await this.api('GET', `/wiki/v2/spaces/${enc(space)}/nodes?${query}`);
    // Feishu omits items for an empty result; only accept omission on a terminal page.
    const items = data.items ?? (data.has_more === false ? [] : undefined);
    if (!Array.isArray(items) || (data.has_more && typeof data.page_token !== 'string')) {
      throw new Error('知识库分页响应无效');
    }
    return { items: items.map(validNode), next: data.has_more ? String(data.page_token) : undefined };
  }
  async create(space: string, parent: string, title: string): Promise<WikiNode> {
    return validNode((await this.api('POST', `/wiki/v2/spaces/${enc(space)}/nodes`, {
      obj_type: 'docx', node_type: 'origin', ...(parent ? {parent_node_token: parent} : {}), title,
    })).node);
  }
  async append(document: string, content: string): Promise<void> {
    // At most 40 paragraphs, each at most 1,000 chars, validated before any remote write.
    const children = content.split('\n').map((line) => ({ block_type: 2,
      text: { elements: [{ text_run: { content: line || ' ' } }] } }));
    await this.api('POST', `/docx/v1/documents/${enc(document)}/blocks/${enc(document)}/children?document_revision_id=-1`,
      { children, index: -1 });
  }
  async read(document: string): Promise<string> {
    const data = await this.api('GET', `/docx/v1/documents/${enc(document)}/raw_content`);
    if (typeof data.content !== 'string') throw new Error('知识库文档正文无效');
    return data.content;
  }
  async move(space: string, parent: string, file: string, type:WikiDocumentType='file') {
    const data = await this.api('POST', `/wiki/v2/spaces/${enc(space)}/nodes/move_docs_to_wiki`, {
      ...(parent?{parent_wiki_token:parent}:{}), obj_type: type, obj_token: file, apply: false,
    });
    const valid=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
    if (data.applied || (!valid(data.wiki_token) && !valid(data.task_id)) ||
      (data.wiki_token!==undefined&&!valid(data.wiki_token)) || (data.task_id!==undefined&&!valid(data.task_id)))
      throw new Error('文件未完成移入，需管理员核对');
    return {...(data.wiki_token?{wiki_token:data.wiki_token as string}:{}),...(data.task_id?{task_id:data.task_id as string}:{})};
  }
  async task(id: string): Promise<WikiNode | null> {
    const data = await this.api('GET', `/wiki/v2/tasks/${enc(id)}?task_type=move`);
    const task = data.task as { move_result?: { node?: WikiNode; status: number }[] } | undefined;
    // Never report success based on status alone; a resolvable destination node is required.
    if(!Array.isArray(task?.move_result)||task.move_result.length!==1)throw new Error('迁入任务结果不完整或不唯一');
    const result = task.move_result[0];
    if(result.status===1)return null;
    if(result.status!==0)throw new Error('迁入任务失败，请核对源文档与目标位置权限；不要重复提交');
    const token = result?.status === 0 ? result.node?.node_token : undefined;
    if(!token)throw new Error('迁入任务缺少目标节点，无法确认完成');
    return this.node(token);
  }
}
