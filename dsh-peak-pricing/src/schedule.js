/**
 * dsh-peak-pricing 共享的纯高峰时段计算逻辑。
 *
 * host 半区直接以 ESM 导入本文件；build-client.mjs 会把同一份源码
 * 剥离 `export ` 前缀后嵌入 lib/client.js（浏览器 bundle），两端共用逻辑。
 *
 * 规则语义：
 *   - provider 精确匹配（同时兼容 * ? 通配）；
 *   - model 支持 * ? 通配；既匹配裸模型名，也匹配 "provider/model" 全名；
 *   - timezone 缺省为本机时区；
 *   - start < end  当天时段（end 不含）；
 *   - start > end  跨午夜（end 位于次日，end 不含）；
 *   - start == end 全天；
 *   - days 缺省每天；显式传空数组表示不生效。
 */

export const DAY_CODES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])

const DAY_SET = new Set(DAY_CODES)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 把通配符模式编译为正则（* → .*，? → .）。 */
export function wildcardMatch(pattern, value) {
  const source = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^(?:${source})$`).test(String(value))
}

/** 解析 "HH:mm" 为分钟数；非法输入返回 null。 */
export function parseHm(value) {
  if (typeof value !== 'string') return null
  const match = TIME_RE.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 校验 IANA 时区名。 */
function assertValidTimeZone(timeZone, label) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone }).format(0)
  } catch {
    throw new TypeError(`${label} is not a valid IANA time zone: ${timeZone}`)
  }
}

/** 本机 IANA 时区名。 */
export function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 使用目标时区取出年月日时分秒与星期。 */
export function dateParts(date, timeZone) {
  const value = date instanceof Date ? date : new Date(date)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value)
  const map = {}
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  let hour = Number(map.hour)
  if (hour === 24) hour = 0 // 部分 Intl 实现对午夜输出 24
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short',
  }).format(value).toLowerCase().slice(0, 3)
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  }
}

/** 目标时区下的 YYYY-MM-DD 日期键。 */
export function dateKey(parts) {
  const mm = String(parts.month).padStart(2, '0')
  const dd = String(parts.day).padStart(2, '0')
  return `${parts.year}-${mm}-${dd}`
}

/** 目标时区下偏移若干天后的日期键。 */
function shiftedDateKey(parts, timeZone, deltaDays) {
  const noon = Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays, 12)
  return dateKey(dateParts(new Date(noon), timeZone))
}

/** days 是否覆盖某星期；缺省表示每天，空数组表示不生效。 */
function dayMatches(days, weekday) {
  if (days === undefined || days === null) return true
  return days.includes(weekday)
}

/**
 * 计算一个 period 在当前时刻的状态。
 * @param {object} period - { days?, start, end }
 * @param {Date|number} date - 判定时刻。
 * @param {string} timeZone - 规则时区。
 * @returns {object} { active, nominalDay, endsAt }
 */
export function periodStatusAt(period, date, timeZone) {
  const startMin = parseHm(period.start)
  const endMin = parseHm(period.end)
  if (startMin === null || endMin === null) {
    throw new TypeError(`invalid period time: ${JSON.stringify(period)}`)
  }
  const parts = dateParts(date, timeZone)
  const nowMin = parts.hour * 60 + parts.minute
  const today = dateKey(parts)
  const weekday = parts.weekday
  const days = period.days
  const endHour = Math.floor(endMin / 60)
  const endMinute = endMin % 60

  if (startMin === endMin) {
    if (!dayMatches(days, weekday)) {
      return { active: false, nominalDay: null, endsAt: null }
    }
    return {
      active: true,
      nominalDay: today,
      endsAt: Date.UTC(parts.year, parts.month - 1, parts.day + 1),
    }
  }

  if (startMin < endMin) {
    const active = dayMatches(days, weekday) && nowMin >= startMin && nowMin < endMin
    return {
      active,
      nominalDay: active ? today : null,
      endsAt: active
        ? Date.UTC(parts.year, parts.month - 1, parts.day, endHour, endMinute)
        : null,
    }
  }

  // 跨午夜：period 的名义日期是 start 所在日。
  const previous = shiftedDateKey(parts, timeZone, -1)
  const previousWeekday = dateParts(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1, 12)), timeZone,
  ).weekday
  const afterStart = nowMin >= startMin
  const beforeEnd = nowMin < endMin
  const activeFromToday = afterStart && dayMatches(days, weekday)
  const activeFromYesterday = beforeEnd && dayMatches(days, previousWeekday)

  if (activeFromToday) {
    return {
      active: true,
      nominalDay: today,
      endsAt: Date.UTC(parts.year, parts.month - 1, parts.day + 1, endHour, endMinute),
    }
  }
  if (activeFromYesterday) {
    return {
      active: true,
      nominalDay: previous,
      endsAt: Date.UTC(parts.year, parts.month - 1, parts.day, endHour, endMinute),
    }
  }
  return { active: false, nominalDay: null, endsAt: null }
}

/**
 * 判断一个规则是否匹配供应商和模型。
 * @param {object} rule - { provider, model }
 * @param {string} provider - 当前供应商。
 * @param {string} model - 当前模型名。
 * @returns {boolean}
 */
export function matchesRule(rule, provider, model) {
  const providerPattern = typeof rule.provider === 'string' && rule.provider !== ''
    ? rule.provider
    : '*'
  if (!wildcardMatch(providerPattern, provider ?? '')) return false
  const pattern = rule.model
  return wildcardMatch(pattern, model ?? '') || wildcardMatch(pattern, `${provider ?? ''}/${model ?? ''}`)
}

/**
 * 在规则集中求当前是否高峰；返回第一个命中的活跃 period。
 * @param {Array} rules - normalizeConfig 后的规则数组。
 * @param {string} provider - 当前供应商。
 * @param {string} model - 当前模型名。
 * @param {Date|number} date - 判定时刻。
 * @param {string} fallbackTimeZone - 缺省时区。
 * @returns {object} { peak: boolean, ... }
 */
export function peakStateAt(rules, provider, model, date, fallbackTimeZone) {
  const tzFallback = fallbackTimeZone || defaultTimeZone()
  const when = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(when.getTime())) throw new TypeError(`invalid date: ${String(date)}`)
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex]
    if (!matchesRule(rule, provider, model)) continue
    const timeZone = rule.timezone || tzFallback
    for (let periodIndex = 0; periodIndex < rule.periods.length; periodIndex += 1) {
      const period = rule.periods[periodIndex]
      const status = periodStatusAt(period, when, timeZone)
      if (!status.active) continue
      return {
        peak: true,
        provider,
        model,
        ruleIndex,
        periodIndex,
        rule,
        period,
        timeZone,
        nominalDay: status.nominalDay,
        endsAt: status.endsAt,
        occurrenceKey: [
          provider,
          model,
          rule.provider,
          rule.model,
          String(ruleIndex),
          String(periodIndex),
          status.nominalDay,
          timeZone,
        ].join('\u0000'),
      }
    }
  }
  return { peak: false, provider, model }
}

/**
 * 校验并归一化配置文件/接口载荷。
 * @param {unknown} input - 原始 JSON 值。
 * @param {string} fallbackTimeZone - timezone 缺省值。
 * @returns {object} 归一化配置。
 */
export function normalizeConfig(input, fallbackTimeZone) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('peak-pricing config must be an object')
  }
  if (!Array.isArray(input.rules)) {
    throw new TypeError('peak-pricing config.rules must be an array')
  }
  const tzFallback = fallbackTimeZone || defaultTimeZone()
  assertValidTimeZone(tzFallback, 'fallbackTimeZone')
  const remindIntervalMinutes = normalizeNonNegativeNumber(
    input.remindIntervalMinutes, 15, 'remindIntervalMinutes')
  const promptTimeoutSeconds = normalizeNonNegativeNumber(
    input.promptTimeoutSeconds, 0, 'promptTimeoutSeconds')

  const rules = input.rules.map((rule, ruleIndex) => {
    const where = `rules[${ruleIndex}]`
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new TypeError(`${where} must be an object`)
    }
    if (typeof rule.provider !== 'string' || rule.provider.trim() === '') {
      throw new TypeError(`${where}.provider must be a non-empty string`)
    }
    if (typeof rule.model !== 'string' || rule.model.trim() === '') {
      throw new TypeError(`${where}.model must be a non-empty string`)
    }
    let timezone = rule.timezone
    if (timezone === undefined) {
      timezone = tzFallback
    } else {
      if (typeof timezone !== 'string' || timezone.trim() === '') {
        throw new TypeError(`${where}.timezone must be a non-empty IANA time zone string`)
      }
      assertValidTimeZone(timezone, `${where}.timezone`)
    }
    if (!Array.isArray(rule.periods)) {
      throw new TypeError(`${where}.periods must be an array`)
    }

    const periods = rule.periods.map((period, periodIndex) => {
      const periodWhere = `${where}.periods[${periodIndex}]`
      if (typeof period !== 'object' || period === null || Array.isArray(period)) {
        throw new TypeError(`${periodWhere} must be an object`)
      }
      let days
      if (period.days !== undefined) {
        if (!Array.isArray(period.days)) {
          throw new TypeError(`${periodWhere}.days must be an array of day codes`)
        }
        const seen = new Set()
        days = period.days.map((day) => {
          if (typeof day !== 'string' || !DAY_SET.has(day)) {
            throw new TypeError(`${periodWhere}.days contains invalid day code: ${String(day)}`)
          }
          if (seen.has(day)) throw new TypeError(`${periodWhere}.days contains duplicate day: ${day}`)
          seen.add(day)
          return day
        })
      }
      if (typeof period.start !== 'string' || parseHm(period.start) === null) {
        throw new TypeError(`${periodWhere}.start must be "HH:mm"`)
      }
      if (typeof period.end !== 'string' || parseHm(period.end) === null) {
        throw new TypeError(`${periodWhere}.end must be "HH:mm"`)
      }
      const normalized = { start: period.start, end: period.end }
      if (days !== undefined) normalized.days = days
      return normalized
    })

    return {
      provider: rule.provider,
      model: rule.model,
      timezone,
      periods,
    }
  })

  return { rules, remindIntervalMinutes, promptTimeoutSeconds }
}

function normalizeNonNegativeNumber(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`peak-pricing config.${name} must be a non-negative number`)
  }
  return value
}

/** 人类可读的时段标签。 */
export function periodLabel(period) {
  return `${period.start}–${period.end}`
}

/** 人类可读的星期过滤标签；缺省返回“每天”。 */
export function daysLabel(days) {
  if (days === undefined || days === null) return '每天'
  if (days.length === 0) return '不生效'
  return days.join(', ')
}
