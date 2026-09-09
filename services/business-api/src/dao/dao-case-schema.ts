import type { QueryExecutor } from "../db/pool";

/**
 * 滚动发布期间应用代码可能先于经批准的数据库迁移上线。只读检测新版表是否存在，
 * 未迁移时继续服务旧案，但绝不自动执行 DDL 或把新版案件降级为旧版立即结算。
 * 不缓存结果：管理员完成迁移后下一次请求即可识别，不要求重置服务或本地链。
 */
export async function hasDaoCaseSchema(db: QueryExecutor): Promise<boolean> {
  const result = await db.query<{ available: boolean }>("SELECT to_regclass('dao_chain_cases') IS NOT NULL AS available", []);
  return result.rows[0]?.available === true;
}
