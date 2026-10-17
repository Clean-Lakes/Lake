import type {AgentEvidence,SRERoleReport} from '../../../shared/contracts';

export const reportEvidence:AgentEvidence[]=[{
 id:'ev_11111111111111111111111111111111',sessionId:'session',runId:'role-run',resourceId:'test-host',resourceName:'测试服务器',title:'磁盘与挂载检查',collectedAt:'2026-10-16T02:22:00Z',excerpt:'Filesystem /dev/vda1 · Size 180G · Used 29G · Avail 143G · Use 17%',exitCode:0,
}];

export const roleReport:SRERoleReport={
 schemaVersion:1,
 summary:'已完成测试服务器的磁盘、挂载与 inode 检查。根分区使用率 **17%**，inode 使用率 **3%**，当前未发现磁盘空间或 inode 耗尽风险。',
 facts:[
  {statement:'`df -hT` 显示根文件系统 `/dev/vda1` 为 ext4，总容量 **180 GB**，已用 29 GB，可用 143 GB。',evidenceIds:[reportEvidence[0]!.id]},
  {statement:'`findmnt` 确认根挂载点 `/` 来自 `/dev/vda1`，当前以 `rw,relatime` 参数读写挂载。',evidenceIds:[reportEvidence[0]!.id]},
  {statement:'`df -i` 显示 inode 总数 11,796,480，已用 319,727，剩余 11,476,753，使用率 3%。',evidenceIds:[reportEvidence[0]!.id]},
  {statement:'`/dev/shm`、`/run` 和用户会话的 tmpfs 挂载均未出现容量紧张。',evidenceIds:[reportEvidence[0]!.id]},
  {statement:'容器 overlay 挂载与根分区共享容量。`lsblk -f` 仅显示磁盘 vda 和分区 vda1，未发现其他数据盘挂载。',evidenceIds:[reportEvidence[0]!.id]},
  {statement:'本次检查命令执行成功（`exitCode=0`），未进行写入或变更操作。',evidenceIds:[reportEvidence[0]!.id]},
 ],
 hypotheses:['容器 overlay 与 shm 挂载较多属于容器运行的正常现象；若根分区持续增长，容器镜像层或日志可能是主要来源，尚未检查具体目录。'],
 unknowns:['未检查 `/var/lib/containers`、`/var/log`、`/home` 的空间占用明细，尚无法定位潜在增长点。','未采集历史磁盘使用趋势，不能判断当前使用率是稳定还是持续增长。'],
 nextChecks:['如需继续定位增长来源，可检查具体目录占用并对比历史监控。'],
};
