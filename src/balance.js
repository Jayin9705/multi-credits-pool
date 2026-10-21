/**
 * 积分余额读取。
 *
 * 两种上游形状：
 * - 个人版：返回套餐列表（Accounts），按包累加剩余额度。
 * - 企业版（仅 CN，凭据里带 enterpriseId）：返回单个周期配额。
 *
 * 读不到就明确报错，绝不把「没看懂响应」渲染成 0——那正是让人信错数字的根源。
 */
import {
  BILLING_BASE,
  JSON_TIMEOUT_MS,
  billingHeaders,
  billingMeterPaths,
  isObject,
  isPathMiss,
  readEnvelope,
  utc8DateTime,
} from './protocol.js'

/** 余额查询的套餐产品码（官方计费接口实测值）。 */
const PRODUCT_CODE = 'p_tcaca'

function numberField(obj, key) {
  return typeof obj[key] === 'number' ? obj[key] : 0
}

/**
 * 到期字段的读取顺序。
 *
 * `CycleEndTime` 是这一段积分本周期结束的时刻，也是唯一有操作意义的截止；
 * `DeductionEndTime` 是产品级的长期扣减截止（实测是 2035 年那种日期），拿它当
 * 到期只会把「马上作废的积分」显示成「还能用十年」。
 */
const EXPIRY_KEYS = ['CycleEndTime', 'ExpiredTime']

function packageEndTime(account) {
  for (const key of EXPIRY_KEYS) {
    const value = account[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number' && value > 0) {
      // 实测数字形态是 epoch 毫秒。
      return new Date(value + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    }
  }
  return undefined
}

/** 到期时刻的毫秒数——排序与倒计时都要数字，字符串留着显示。 */
function packageEndMs(account) {
  const text = packageEndTime(account)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

function parsePersonal(envelope) {
  const wrapper = isObject(envelope.data) ? envelope.data : {}
  const response = isObject(wrapper.Response) ? wrapper.Response : {}
  const data = isObject(response.Data) ? response.Data : (isObject(wrapper.Data) ? wrapper.Data : {})
  const rows = Array.isArray(data.Accounts) ? data.Accounts : []

  // 每个套餐都单独留着：同一账号下常有多段积分，各自的到期时间不同，
  // 只有逐段列出来才看得出「哪一段先作废」。
  const packages = []
  const groups = new Map()
  let total = 0
  let totalSize = 0
  for (const raw of rows) {
    if (!isObject(raw)) continue
    const size = numberField(raw, 'CycleCapacitySize')
    const cycleRemain = numberField(raw, 'CycleCapacityRemain')
    const cycleUsed = numberField(raw, 'CycleCapacityUsed')
    const capacityRemain = numberField(raw, 'CapacityRemain')
    // 三种剩余额度的表达方式择一：周期容量优先，其次周期剩余，最后总剩余。
    const remain = Math.max(0, size > 0 ? cycleRemain : (cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : capacityRemain))
    const pkgSize = size > 0 ? size : numberField(raw, 'CapacitySize')
    const name = typeof raw.PackageName === 'string' && raw.PackageName !== '' ? raw.PackageName : '(未命名套餐)'
    const endTime = packageEndTime(raw)
    total += remain
    totalSize += pkgSize
    packages.push({
      packageName: name,
      packageCode: typeof raw.PackageCode === 'string' ? raw.PackageCode : undefined,
      remain,
      size: pkgSize,
      used: Math.max(0, pkgSize - remain),
      endTime,
      endTimeMs: packageEndMs(raw),
      startTime: typeof raw.CycleStartTime === 'string' && raw.CycleStartTime !== '' ? raw.CycleStartTime : undefined,
    })

    // 按套餐名聚合：同名的多期（裂变包常见）算一组，到期取最早那一期——
    // 概览行要回答的是「这批积分什么时候开始作废」。
    const known = groups.get(name)
    if (known === undefined) {
      groups.set(name, { name, remain, size: pkgSize, count: 1, endTime, endTimeMs: packageEndMs(raw) })
    } else {
      known.remain += remain
      known.size += pkgSize
      known.count += 1
      const ms = packageEndMs(raw)
      if (ms !== undefined && (known.endTimeMs === undefined || ms < known.endTimeMs)) {
        known.endTimeMs = ms
        known.endTime = endTime
      }
    }
  }
  // TotalDosage 作为总量下限：已消耗不可能超过总量。
  const dosage = numberField(data, 'TotalDosage')
  if (dosage > totalSize) totalSize = dosage
  return {
    kind: 'personal',
    total,
    totalSize: totalSize || undefined,
    packages,
    groups: [...groups.values()].sort((a, b) => (a.endTimeMs ?? Infinity) - (b.endTimeMs ?? Infinity)),
  }
}

function indexOfAny(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === 'number') return obj[key]
  }
  return undefined
}

function parseEnterprise(envelope) {
  const wrapper = isObject(envelope.data) ? envelope.data : {}
  const response = isObject(wrapper.Response) ? wrapper.Response : wrapper
  const data = isObject(response.Data) ? response.Data : response
  // 官方两个调用点的字段拼写不一致（limitNum/credit 与 limit_num/used_num），都收。
  const limit = indexOfAny(data, ['limitNum', 'limit_num', 'credit', 'totalNum'])
    ?? (isObject(data.data) ? indexOfAny(data.data, ['limitNum', 'limit_num', 'credit', 'totalNum']) : undefined)
  const used = indexOfAny(data, ['usedNum', 'used_num', 'usedCredit'])
    ?? (isObject(data.data) ? indexOfAny(data.data, ['usedNum', 'used_num', 'usedCredit']) : undefined)
  if (limit === undefined) {
    throw new Error('企业版余额响应里没有可识别的配额字段')
  }
  const remain = Math.max(0, limit - (used ?? 0))
  const endTime = packageEndTime(data)
  // `-1` 是上游的「不限量」标记，不是余额——单独给标志位，任何界面都不能把它当数字画。
  if (limit === -1) {
    const resetTime = typeof data.cycleResetTime === 'string' && data.cycleResetTime !== '' ? data.cycleResetTime : undefined
    const unlimitedPackage = { packageName: '企业版周期配额', remain: 0, size: 0, used: 0, unlimited: true, endTime: resetTime, endTimeMs: undefined }
    return {
      kind: 'enterprise',
      unlimited: true,
      total: 0,
      totalSize: undefined,
      packages: [unlimitedPackage],
      groups: [{ name: '企业版周期配额', remain: 0, size: 0, count: 1, unlimited: true, endTime: resetTime, endTimeMs: undefined }],
    }
  }
  const pkg = { packageName: '企业版周期配额', remain, size: limit, used: Math.max(0, limit - remain), endTime, endTimeMs: packageEndMs(data) }
  return {
    kind: 'enterprise',
    total: remain,
    totalSize: limit,
    packages: [pkg],
    groups: [{ name: '企业版周期配额', remain, size: limit, count: 1, endTime, endTimeMs: packageEndMs(data) }],
  }
}

/**
 * 读一个账号的积分余额。
 * @param {object} account 账号记录
 * @param {string} accessToken 已保证新鲜的访问令牌
 */
export async function fetchCredits(account, accessToken) {
  const credential = { ...account, accessToken }
  const isGlobal = account.region === 'global'

  if (!isGlobal && account.enterpriseId) {
    const response = await fetch(`${BILLING_BASE.cn}/v2/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`企业版余额读取失败（http ${response.status}, code ${envelope.code}）：${envelope.msg.slice(0, 120)}`)
    }
    return parseEnterprise(envelope)
  }

  const now = Date.now()
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: utc8DateTime(now),
    PackageEndTimeRangeEnd: utc8DateTime(now + 365 * 101 * 24 * 3600 * 1000),
  })

  let response
  let lastStatus = 0
  for (const path of billingMeterPaths(account.region)) {
    const attempt = await fetch(`${BILLING_BASE[account.region]}${path}`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    lastStatus = attempt.status
    // 只有路由落空才换路径；业务错误必须原样报出。
    if (attempt.ok || !isPathMiss(attempt.status)) {
      response = attempt
      break
    }
  }
  if (response === undefined) throw new Error(`余额接口不可用（http ${lastStatus}）`)

  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`余额读取失败（http ${response.status}, code ${envelope.code}）：${envelope.msg.slice(0, 120)}`)
  }
  return parsePersonal(envelope)
}
