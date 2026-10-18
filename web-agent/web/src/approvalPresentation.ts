import type {AIView} from '../../shared/contracts';

type Approval=NonNullable<AIView['pending']>;
/** A protected/opaque shell script is not evidence of a delete operation. */
export function approvalPresentation(p:Approval){
 if(p.call.name==='stage_attachment')return {title:'确认传输附件',note:(p.kind==='file_write'?'上传附件使用“静默修改文件”权限；当前未开启，请确认本次传输。':'')+'将原文件传到以下目标路径。覆盖已有文件需要明确设置；解压和部署是后续独立操作。'};
 if(p.kind==='delete')return p.call.name==='delete'
  ?{title:'删除操作需要确认',note:'本次确认仅覆盖下面指定的删除操作，请核对完整路径。'}
  :{title:'命令需要额外确认',note:'当前命令未通过静默执行检查。请核对目标和完整命令，本次确认仅覆盖此操作。'};
 return {title:p.risk==='dangerous'?'危险操作需要确认目标':({mcp:'授权本次 MCP 操作',adopt_terminal:'授权访问其他会话的终端',resource_select:'确认本次操作的目标资源',terminal_open:'授权创建终端会话',file_read:'授权读取文件',file_write:'授权修改文件',resource_import:'确认导入资源',readonly_sql:'授权执行只读 SQL',command:'授权执行本次命令'} as Record<string,string>)[p.kind||'']||'确认本次操作',note:''};
}
