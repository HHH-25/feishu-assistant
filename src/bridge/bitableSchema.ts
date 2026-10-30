import {z} from 'zod/v4';
export const baseId=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const name=z.string().trim().min(1).max(100);
const tableName=name.refine(s=>!/[\\/?:*\[\]]/.test(s),'名称包含不支持的字符');
const viewName=name.refine(s=>!/[\[\]]/.test(s));
const op=z.enum(['is','isNot','contains','doesNotContain','isEmpty','isNotEmpty','isGreater','isGreaterEqual','isLess','isLessEqual']);
const condition=z.object({field_name:z.string().min(1).max(1000),operator:op,value:z.array(z.string().max(4000)).max(10).optional()}).strict();
export const recordFilter=z.object({conjunction:z.enum(['and','or']),conditions:z.array(condition).min(1).max(50)}).strict();
export const searchShape={base:baseId,table_id:baseId,view_id:baseId.optional(),field_names:z.array(name).max(200).optional(),
  filter:recordFilter.optional(),sort:z.array(z.object({field_name:name,desc:z.boolean()}).strict()).max(20).optional(),
  cursor:z.string().max(2000).optional(),query_ref:z.string().uuid().optional(),page_size:z.number().int().min(1).max(100).optional()};
export const searchSchema=z.object(searchShape).strict();
const serial=z.object({type:z.enum(['custom','auto_increment_number']),options:z.array(z.object({type:z.enum(['system_number','fixed_text','created_time']),value:z.string().max(20)}).strict()).max(20).optional()}).strict();
const property=z.object({options:z.array(z.object({name:z.string().min(1).max(200),id:baseId.optional(),color:z.number().int().min(0).max(54).optional()}).strict()).max(300).optional(),
  formatter:z.string().max(50).optional(),date_formatter:z.string().max(50).optional(),auto_fill:z.boolean().optional(),multiple:z.boolean().optional(),
  table_id:baseId.optional(),back_field_name:name.optional(),auto_serial:serial.optional(),
  min:z.number().optional(),max:z.number().optional(),range_customize:z.boolean().optional(),currency_code:z.string().max(5).optional(),
  rating:z.object({symbol:name}).strict().optional(),location:z.object({input_type:z.enum(['only_mobile','not_limit'])}).strict().optional(),
  allowed_edit_modes:z.object({manual:z.boolean().optional(),scan:z.boolean().optional()}).strict().optional()}).strict();
// Formula expressions and lookup creation have inconsistent support across base versions; never silently ignore them.
export const fieldSchema=z.object({field_name:name,type:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5),z.literal(7),z.literal(11),z.literal(13),z.literal(15),z.literal(17),z.literal(18),z.literal(21),z.literal(22),z.literal(23),z.literal(1001),z.literal(1002),z.literal(1003),z.literal(1004),z.literal(1005)]),
  ui_type:z.enum(['Text','Email','Barcode','Number','Progress','Currency','Rating','SingleSelect','MultiSelect','DateTime','Checkbox','User','Phone','Url','Attachment','SingleLink','DuplexLink','Location','GroupChat','CreatedTime','ModifiedTime','CreatedUser','ModifiedUser','AutoNumber']).optional(),
  property:property.optional(),description:z.object({text:z.string().max(2000),disable_sync:z.boolean().optional()}).strict().optional()}).strict();
const fields=z.record(z.string().min(1).max(100),z.unknown()).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=100&&JSON.stringify(v).length<=40000,'记录字段不能为空或过大');
const viewProperty=z.object({filter_info:z.object({conjunction:z.enum(['and','or']),conditions:z.array(z.object({field_id:baseId,operator:op,value:z.string().max(4000).optional()}).strict()).max(50)}).strict().optional(),
  hidden_fields:z.array(baseId).max(300).optional(),hierarchy_config:z.object({field_id:baseId}).strict().optional()}).strict();
const permission=z.union([z.literal(0),z.literal(1)]);
const rule=z.object({conjunction:z.enum(['and','or']),conditions:z.array(z.object({field_name:z.string().max(100),operator:z.enum(['is','isNot','contains','doesNotContain','isEmpty','isNotEmpty']),value:z.array(z.string()).max(50).optional()}).strict()).max(10)}).strict();
const tableRole=z.object({table_id:baseId,table_perm:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(4)]),
  rec_rule:rule.extend({other_perm:permission}).optional(),other_rec_rule:rule.optional(),
  field_perm:z.record(name,z.union([z.literal(1),z.literal(2),z.literal(3)])).optional(),
  allow_add_record:z.boolean(),allow_delete_record:z.boolean(),view_perm:z.union([z.literal(1),z.literal(2)]),
  view_rules:z.record(baseId,permission).optional(),field_action_rules:z.object({select_option_edit:z.record(name,permission).optional(),attachment_export:z.record(name,permission).optional()}).strict().optional()}).strict();
export const roleSchema=z.object({role_name:name,table_roles:z.array(tableRole).max(100),
  block_roles:z.array(z.object({block_id:baseId,block_perm:permission}).strict()).max(100),
  base_rule:z.object({base_complex_edit:permission,copy:permission}).strict()}).strict();
const table={table_id:baseId};
export const changeSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('rename_base'),name:tableName}).strict(),
  z.object({action:z.literal('set_advanced'),enabled:z.boolean()}).strict(),
  z.object({action:z.literal('create_table'),name:tableName}).strict(),
  z.object({action:z.literal('rename_table'),...table,name:tableName}).strict(),
  z.object({action:z.literal('delete_table'),...table}).strict(),
  z.object({action:z.literal('create_field'),...table,field:fieldSchema}).strict(),
  z.object({action:z.literal('update_field'),...table,field_id:baseId,field:fieldSchema}).strict(),
  z.object({action:z.literal('delete_field'),...table,field_id:baseId}).strict(),
  z.object({action:z.literal('create_records'),...table,records:z.array(z.object({fields}).strict()).min(1).max(100)}).strict(),
  z.object({action:z.literal('update_records'),...table,records:z.array(z.object({record_id:baseId,fields}).strict()).min(1).max(100)}).strict(),
  z.object({action:z.literal('delete_records'),...table,record_ids:z.array(baseId).min(1).max(100)}).strict(),
  z.object({action:z.literal('create_view'),...table,view_name:viewName,view_type:z.enum(['grid','kanban','gallery','gantt','form'])}).strict(),
  z.object({action:z.literal('update_view'),...table,view_id:baseId,view_name:viewName.optional(),property:viewProperty.optional()}).strict(),
  z.object({action:z.literal('delete_view'),...table,view_id:baseId}).strict(),
  z.object({action:z.literal('create_role'),role:roleSchema}).strict(),
  z.object({action:z.literal('update_role'),role_id:baseId,role:roleSchema}).strict(),
  z.object({action:z.literal('delete_role'),role_id:baseId}).strict(),
  z.object({action:z.literal('add_role_member'),role_id:baseId,recipient:baseId}).strict(),
  z.object({action:z.literal('remove_role_member'),role_id:baseId,recipient:baseId}).strict(),
  z.object({action:z.literal('copy_dashboard'),block_id:baseId,name}).strict(),
  z.object({action:z.literal('set_workflow'),workflow_id:baseId,status:z.enum(['Enable','Disable'])}).strict(),
]);
export type BitableChange=z.infer<typeof changeSchema>;
export type BitableSearch=z.infer<typeof searchSchema>;
export const listShape={base:baseId,kind:z.enum(['tables','fields','views','roles','role_members','dashboards','workflows']),table_id:baseId.optional(),role_id:baseId.optional(),cursor:z.string().max(2000).optional()};
export const listSchema=z.object(listShape).strict();
