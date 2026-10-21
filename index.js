/**
 * 包入口。宿主按 cordis.patch.yml 里的 `name` 解析到本包，从这里取
 * name / inject / apply 三个导出。
 */
export { apply, name, inject } from './src/plugin.js'
