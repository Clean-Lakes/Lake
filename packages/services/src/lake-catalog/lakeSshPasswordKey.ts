/** 密码仅存于应用凭据库，不进入 lake-catalog.sqlite。 */
export function lakeSshPasswordKey(resourceId: string): string {
  return `lake:ssh:${resourceId}:password`;
}
