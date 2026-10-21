/**
 * 账号轮换状态与选用策略。
 *
 * 失败冷却与「用哪个账号」是两件事，所以分成两层：
 * - 冷却：请求失败后把账号暂时排除，与策略无关，永远生效。
 * - 策略：在没进冷却的账号里挑一个，由用户选。
 *
 * 四种策略：
 * - `sticky`（对话固定，缺省）：同一段对话始终用同一个账号，新对话才换人。对上游
 *   提示缓存最友好——缓存按账号隔离，来回换账号等于每次都从零开始。
 * - `sequential`（优先用完一个）：把第一个账号的积分用尽，冷却打开后才换下一个。
 * - `expiring`（优先过期）：剩余积分里最先过期的先用，用积分换时间。
 * - `round-robin`（轮询）：按顺序轮换，把积分消耗摊平到各账号。
 *
 * 对话固定下有两类绑定，优先级不同：
 * - 手动固定（{@link AccountRotator#pinConversation}）：用户在对话头部显式指定的账号。
 *   用户说用谁就用谁，不因为对话闲置而过期，也不被自动绑定覆盖。
 * - 自动绑定：`order()` 第一次见到某段对话时顺手记下的账号，闲置超过 `idleMs`
 *   就当作新对话重新选人。
 *
 * 两者分开存，是因为「用户的选择」和「上次碰巧用了谁」不是一回事——混在一张表里，
 * 闲置过期会把用户的选择冲掉。
 */

export const COOLDOWN_MS = {
  hard_credit: 6 * 60 * 60 * 1000,
  soft_rate: 5 * 60 * 1000,
  session_dead: 30 * 60 * 1000,
}

export const STRATEGIES = ['sticky', 'sequential', 'expiring', 'round-robin']

export const DEFAULT_STRATEGY = 'sticky'

export const STRATEGY_LABELS = {
  sticky: '对话固定',
  sequential: '优先用完一个',
  expiring: '优先过期',
  'round-robin': '轮询',
}

export function isStrategy(value) {
  return STRATEGIES.includes(value)
}

/** 冷却时间按失败类别取；未登记的类别不冷却（例如网络错误）。 */
export function cooldownFor(kind) {
  return COOLDOWN_MS[kind] ?? 0
}

/** 一段对话闲置多久后视为「新对话」，下次请求重新选账号（10 分钟）。 */
export const STICKY_IDLE_MS = 10 * 60 * 1000

/**
 * 「优先用完一个」里视为「余量见底」的阈值。
 *
 * 低于这个数就把账号排到队尾，好让当前账号先被彻底用干。取值取小是为了只在
 * 余额确实快没了时才让位——否则上游报额度耗尽前代理就提前跳走，等于把
 * 「优先用完一个」又变回轮询。
 */
export const SEQUENTIAL_FLOOR_CREDITS = 1_000

/** 剩余积分里最早过期的时刻（epoch 毫秒）；读不到过期的排到最后。 */
export function soonestExpiry(account) {
  const packages = Array.isArray(account?.packages) ? account.packages : []
  let soonest = Number.POSITIVE_INFINITY
  for (const pkg of packages) {
    const end = Date.parse(`${String(pkg?.endTime ?? '').replace(' ', 'T')}+08:00`)
    if (Number.isFinite(end) && end < soonest) soonest = end
  }
  return soonest
}

/** 自动绑定表的上限，超过就丢最老的对话。 */
export const MAX_BINDINGS = 500

/** 手动固定表的上限，与自动绑定同量级。 */
export const MAX_PINS = 500

export class AccountRotator {
  constructor(options = {}) {
    this.now = options.now ?? Date.now
    this.cooldowns = options.cooldowns ?? COOLDOWN_MS
    this.strategy = isStrategy(options.strategy) ? options.strategy : DEFAULT_STRATEGY
    this.idleMs = options.idleMs ?? STICKY_IDLE_MS
    this.defaultStrategy = this.strategy
    /** @type {Map<string, number>} id → 最近一次使用时刻 */
    this.lastUsed = new Map()
    /** @type {Map<string, number>} id → 冷却到期时刻 */
    this.cooldownUntil = new Map()
    /** @type {Map<string, {accountId: string, at: number}>} 对话键 → 自动绑定 */
    this.bindings = new Map()
    /** @type {Map<string, {accountId: string, at: number}>} 对话键 → 用户手动固定 */
    this.pins = new Map()
    /** @type {Map<string, object>} id → 最近一次见过的账号记录（额度快照跟着它走） */
    this.seen = new Map()
    /** @type {Map<string, {credits?: number, at?: number}>} id → 最近一次余额读数 */
    this.balance = new Map()
  }

  setStrategy(strategy) {
    if (!isStrategy(strategy)) return this.strategy
    this.strategy = strategy
    return this.strategy
  }

  /** 是否处于冷却中。 */
  isCoolingDown(accountId, at = this.now()) {
    const until = this.cooldownUntil.get(accountId)
    if (until === undefined) return false
    if (until <= at) {
      this.cooldownUntil.delete(accountId)
      return false
    }
    return true
  }

  /**
   * 把当前的账号记录喂给轮换器，让「优先过期」与「优先用完一个」能用上余额信息。
   * 余额读数本身由调用方在拿到新数据时用 {@link noteBalance} 补进来。
   */
  observe(accounts) {
    for (const account of accounts) this.seen.set(account.id, account)
    for (const id of [...this.seen.keys()]) {
      if (!accounts.some(account => account.id === id)) {
        this.seen.delete(id)
        this.balance.delete(id)
        this.bindings.delete(id)
      }
    }
    // 固定表按当前账号库整表校验：账号被删了，固定到它身上的对话一并解开，
    // 免得请求一直往不存在的账号上撞。这里不能只扫 seen——固定可能建立在本轮
    // 观察之前，那个账号未必进过 seen。
    const alive = new Set(accounts.map(account => account.id))
    for (const [key, pin] of this.pins) if (!alive.has(pin.accountId)) this.pins.delete(key)
  }

  /**
   * 记录一次余额读数（可选，参与 expiring/sequential 排序）。
   *
   * `expireAt` 传账号最早到期的毫秒时刻。读不到到期日时不传或传 `Infinity`，
   * 排序会把它排到最后——不会把「不知道」当成「明天过期」。显式读数一经记下
   * 就保留，后续只更新积分时不传 `expireAt` 不会把它清掉。
   */
  noteBalance(accountId, credits, at = this.now(), expireAt = undefined) {
    const previous = this.balance.get(accountId)
    const next = { credits, at }
    if (typeof expireAt === 'number') next.expireAt = expireAt
    else if (previous?.expireAt !== undefined) next.expireAt = previous.expireAt
    this.balance.set(accountId, next)
  }

  /** 带余额的账号视图。 */
  #view(account) {
    const balance = this.balance.get(account.id)
    const stored = this.seen.get(account.id)
    const merged = { ...(stored ?? account) }
    if (balance?.credits !== undefined) merged.credits = balance.credits
    // 调用方显式给了到期时刻就用它，否则回落到账号记录里的套餐到期时间。
    if (balance?.expireAt !== undefined) merged.expireAt = balance.expireAt
    return merged
  }

  /** 策略排序：健康账号在前，冷却中的按解冻时间垫底。 */
  #rank(accounts, at) {
    const healthy = []
    const cooling = []
    for (const account of accounts) {
      if (this.isCoolingDown(account.id, at)) cooling.push(account)
      else healthy.push(account)
    }
    const lastUsed = account => this.lastUsed.get(account.id) ?? 0
    const creditsOf = account => {
      const value = this.#view(account).credits
      return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
    }
    const getExpiry = account => {
      const explicit = this.#view(account).expireAt
      if (typeof explicit === 'number') return explicit
      return soonestExpiry(this.#view(account))
    }
    if (this.strategy === 'sequential') {
      // 把一个账号用到底：余量够用的排前面，其中用得最多的先上；
      // 余量见底的按「剩得最少的先」垫底，好让它尽快被彻底用干。
      healthy.sort((a, b) => {
        const ea = creditsOf(a) < SEQUENTIAL_FLOOR_CREDITS
        const eb = creditsOf(b) < SEQUENTIAL_FLOOR_CREDITS
        if (ea !== eb) return ea ? 1 : -1
        if (ea) return creditsOf(a) - creditsOf(b)
        return lastUsed(b) - lastUsed(a)
      })
    } else if (this.strategy === 'expiring') {
      healthy.sort((a, b) => {
        const ea = getExpiry(a)
        const eb = getExpiry(b)
        if (ea !== eb) return ea - eb
        // 同一批过期的积分，先烧余额少的，减少作废量。
        const ca = creditsOf(a)
        const cb = creditsOf(b)
        if (ca !== cb) return ca - cb
        return lastUsed(a) - lastUsed(b)
      })
    } else {
      // sticky 与 round-robin 都按 LRU 起手，区别在于 sticky 会被对话绑定劫持。
      healthy.sort((a, b) => lastUsed(a) - lastUsed(b))
    }
    cooling.sort((a, b) => (this.cooldownUntil.get(a.id) ?? 0) - (this.cooldownUntil.get(b.id) ?? 0))
    return [...healthy, ...cooling]
  }

  /**
   * 可尝试顺序。
   *
   * `conversationId` 只在 sticky 下起作用：用户手动固定过的对话直接用固定账号，
   * 否则命中未过期的自动绑定就把那个账号提到最前。两种绑定在账号进冷却时都照常
   * 跳过——对话绑定不该让人卡在一个坏账号上。
   */
  order(accounts, options = {}) {
    const at = options.at ?? this.now()
    const conversationId = options.conversationId
    const ranked = this.#rank(accounts, at)

    if (this.strategy !== 'sticky' || typeof conversationId !== 'string' || conversationId === '') return ranked

    const pin = this.pins.get(conversationId)
    if (pin !== undefined) {
      // 手动固定不设闲置过期，只在账号不可用时让位。
      if (this.isCoolingDown(pin.accountId, at)) return ranked
      const pinnedIndex = ranked.findIndex(account => account.id === pin.accountId)
      if (pinnedIndex <= 0) return ranked
      const [pinned] = ranked.splice(pinnedIndex, 1)
      return [pinned, ...ranked]
    }

    const bound = this.bindings.get(conversationId)
    if (bound === undefined) {
      this.#bind(conversationId, ranked[0]?.id, at)
      return ranked
    }
    if (at - bound.at > this.idleMs) {
      // 闲置太久，当成新对话：重新选人。
      this.#bind(conversationId, ranked[0]?.id, at)
      return ranked
    }
    if (this.isCoolingDown(bound.accountId, at)) return ranked

    const index = ranked.findIndex(account => account.id === bound.accountId)
    if (index <= 0) {
      bound.at = at
      return ranked
    }
    const [pinned] = ranked.splice(index, 1)
    bound.at = at
    return [pinned, ...ranked]
  }

  #bind(conversationId, accountId, at) {
    if (typeof conversationId !== 'string' || conversationId === '' || accountId === undefined) return
    this.bindings.set(conversationId, { accountId, at })
    // 绑定表不能无限长：超过上限就丢掉最老的。
    if (this.bindings.size > MAX_BINDINGS) {
      const oldest = [...this.bindings.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) this.bindings.delete(oldest[0])
    }
  }

  /** 对话当前绑在哪个账号上（诊断用）。 */
  boundAccount(conversationId, at = this.now()) {
    const bound = this.bindings.get(conversationId)
    if (bound === undefined) return undefined
    return at - bound.at > this.idleMs ? undefined : bound.accountId
  }

  /**
   * 手动把一段对话固定到某个账号。
   *
   * 固定优先于自动绑定，且不随闲置过期；账号被删或进冷却时 `order()` 会照常让位。
   * 传 `null`/`undefined` 等同于 {@link unpinConversation}。
   */
  pinConversation(conversationId, accountId, at = this.now()) {
    if (typeof conversationId !== 'string' || conversationId === '') return undefined
    if (typeof accountId !== 'string' || accountId === '') return this.unpinConversation(conversationId)
    this.pins.set(conversationId, { accountId, at })
    // 固定表同样不能无限长，超了丢最老的。
    if (this.pins.size > MAX_PINS) {
      const oldest = [...this.pins.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) this.pins.delete(oldest[0])
    }
    return accountId
  }

  /** 取消手动固定，返回是否真的解开了。 */
  unpinConversation(conversationId) {
    return this.pins.delete(conversationId)
  }

  /** 对话被手动固定到哪个账号（不看闲置时间）。 */
  pinnedAccount(conversationId) {
    return this.pins.get(conversationId)?.accountId
  }

  /** 全部手动固定，形状是 `{对话键: 账号 id}`。 */
  listPins() {
    return Object.fromEntries([...this.pins].map(([key, pin]) => [key, pin.accountId]))
  }

  /** 从落盘数据恢复手动固定（插件启动时调用）。 */
  restorePins(pins) {
    if (pins === null || typeof pins !== 'object') return 0
    let restored = 0
    for (const [key, accountId] of Object.entries(pins)) {
      if (typeof key !== 'string' || typeof accountId !== 'string' || key === '' || accountId === '') continue
      this.pins.set(key, { accountId, at: this.now() })
      restored += 1
    }
    return restored
  }

  /** 用一份完整表替换当前固定（界面改完之后同步用）。 */
  setPins(pins) {
    this.pins.clear()
    return this.restorePins(pins)
  }

  noteSuccess(accountId, at = this.now()) {
    this.lastUsed.set(accountId, at)
    this.cooldownUntil.delete(accountId)
  }

  noteFailure(accountId, kind, at = this.now()) {
    const cooldown = this.cooldowns[kind] ?? 0
    if (cooldown > 0) this.cooldownUntil.set(accountId, at + cooldown)
  }

  /** 诊断用快照。 */
  snapshot(at = this.now()) {
    return {
      strategy: this.strategy,
      lastUsed: Object.fromEntries(this.lastUsed),
      cooldownUntil: Object.fromEntries([...this.cooldownUntil].filter(([, until]) => until > at)),
      bindings: this.bindings.size,
      pins: this.pins.size,
    }
  }
}
