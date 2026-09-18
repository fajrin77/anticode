/*
 * A small line tokenizer for the diff viewer. It knows comments, strings,
 * numbers, keywords, types, and calls for the languages a coding session
 * mostly touches, enough to read a diff at a glance, nothing like a parser.
 * State (a block comment or a multi-line string) carries from line to line,
 * so feed it the lines of one side of a file in order.
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'call' | 'tag'

export interface Token {
  kind: TokenKind
  text: string
}

interface Language {
  keywords: Set<string>
  lineComment: string[]
  block: [string, string] | null
  quotes: string[]
  /** Quotes whose strings may run on past the end of a line. */
  multiline: string[]
  /** Markup: `<tag` and `</tag` are tags, text between is plain. */
  markup?: boolean
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter((word) => word !== ''))

const C_LIKE = { lineComment: ['//'], block: ['/*', '*/'] as [string, string], quotes: ['"', "'"], multiline: [] }

const LANGUAGES: Record<string, Language> = {
  js: {
    ...C_LIKE,
    quotes: ['"', "'", '`'],
    multiline: ['`'],
    keywords: words(`await async break case catch class const continue debugger default delete do else enum export
      extends false finally for from function get if implements import in instanceof interface let new null of
      private protected public readonly return set static super switch this throw true try type typeof undefined
      var void while with yield as satisfies keyof declare namespace abstract override`)
  },
  py: {
    lineComment: ['#'], block: null, quotes: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"],
    keywords: words(`and as assert async await break class continue def del elif else except False finally for from
      global if import in is lambda None nonlocal not or pass raise return True try while with yield self match case`)
  },
  go: {
    ...C_LIKE, quotes: ['"', "'", '`'], multiline: ['`'],
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface
      map package range return select struct switch type var nil true false`)
  },
  rs: {
    ...C_LIKE,
    keywords: words(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop
      match mod move mut pub ref return self Self static struct super trait true type unsafe use where while None Some Ok Err`)
  },
  c: {
    ...C_LIKE,
    keywords: words(`auto break case catch char class const continue default delete do double else enum explicit extern
      false final float for friend goto if inline int long namespace new null nullptr operator override private
      protected public return short signed sizeof static struct switch template this throw true try typedef typename
      union unsigned using virtual void volatile while boolean byte extends implements import instanceof interface
      package super synchronized throws val var fun when object data sealed let func guard struct protocol extension`)
  },
  css: {
    lineComment: [], block: ['/*', '*/'], quotes: ['"', "'"], multiline: [],
    keywords: words(`important media import supports keyframes font-face from to and not only`)
  },
  sh: {
    lineComment: ['#'], block: null, quotes: ['"', "'"], multiline: [],
    keywords: words(`if then else elif fi for while until do done case esac in function return local export echo exit
      set unset source cd shift break continue true false`)
  },
  sql: {
    lineComment: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], multiline: [],
    keywords: words(`select from where insert into values update set delete create table alter drop index join left right
      inner outer on as and or not null is in like group by order having limit offset union primary key foreign
      references default distinct case when then else end returning SELECT FROM WHERE INSERT INTO VALUES UPDATE SET
      DELETE CREATE TABLE ALTER DROP INDEX JOIN LEFT RIGHT INNER OUTER ON AS AND OR NOT NULL IS IN LIKE GROUP BY ORDER
      HAVING LIMIT OFFSET UNION PRIMARY KEY FOREIGN REFERENCES DEFAULT DISTINCT CASE WHEN THEN ELSE END RETURNING`)
  },
  yaml: { lineComment: ['#'], block: null, quotes: ['"', "'"], multiline: [], keywords: words('true false null yes no on off') },
  json: { lineComment: [], block: null, quotes: ['"'], multiline: [], keywords: words('true false null') },
  rb: {
    lineComment: ['#'], block: null, quotes: ['"', "'"], multiline: [],
    keywords: words(`alias and begin break case class def defined do else elsif end ensure false for if in module next nil
      not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor`)
  },
  php: {
    lineComment: ['//', '#'], block: ['/*', '*/'], quotes: ['"', "'"], multiline: [],
    keywords: words(`abstract and array as break case catch class clone const continue declare default do echo else
      elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function
      global if implements include instanceof interface isset list match namespace new null or print private
      protected public require return static switch this throw trait true false try unset use var while yield`)
  },
  html: { lineComment: [], block: ['<!--', '-->'], quotes: ['"', "'"], multiline: [], keywords: new Set(), markup: true }
}

const EXTENSIONS: Record<string, string> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  py: 'py', pyw: 'py',
  go: 'go',
  rs: 'rs',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', java: 'c', kt: 'c', kts: 'c', swift: 'c', scala: 'c', dart: 'c',
  css: 'css', scss: 'css', less: 'css',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml',
  json: 'json', jsonc: 'js',
  rb: 'rb',
  php: 'php',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html'
}

export function languageOf(path: string): string | null {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  if (/^(Dockerfile|Makefile)$/i.test(name)) return 'sh'
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : ''
  return EXTENSIONS[extension] ?? null
}

interface State {
  /** Inside a block comment. */
  comment: boolean
  /** Inside a string that runs across lines, opened by this quote. */
  quote: string | null
}

const NUMBER = /^(0x[\da-f_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?(e[+-]?\d+)?)[a-z]*/i
const WORD = /^[A-Za-z_$][\w$]*/

function push(tokens: Token[], kind: TokenKind, text: string): void {
  if (text === '') return
  const last = tokens.at(-1)
  if (last?.kind === kind) last.text += text
  else tokens.push({ kind, text })
}

function tokenizeLine(line: string, language: Language, state: State): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < line.length) {
    const rest = line.slice(at)
    if (state.comment && language.block !== null) {
      const end = rest.indexOf(language.block[1])
      if (end < 0) { push(tokens, 'comment', rest); return tokens }
      push(tokens, 'comment', rest.slice(0, end + language.block[1].length))
      at += end + language.block[1].length
      state.comment = false
      continue
    }
    if (state.quote !== null) {
      const end = closingQuote(rest, state.quote)
      if (end < 0) { push(tokens, 'string', rest); return tokens }
      push(tokens, 'string', rest.slice(0, end))
      at += end
      state.quote = null
      continue
    }
    if (language.lineComment.some((marker) => rest.startsWith(marker))) {
      push(tokens, 'comment', rest)
      return tokens
    }
    if (language.block !== null && rest.startsWith(language.block[0])) {
      state.comment = true
      push(tokens, 'comment', language.block[0])
      at += language.block[0].length
      continue
    }
    const quote = language.quotes.find((mark) => rest.startsWith(mark))
    if (quote !== undefined) {
      const end = closingQuote(rest.slice(quote.length), quote)
      if (end < 0) {
        push(tokens, 'string', rest)
        if (language.multiline.includes(quote)) state.quote = quote
        return tokens
      }
      push(tokens, 'string', rest.slice(0, quote.length + end))
      at += quote.length + end
      continue
    }
    if (language.markup === true) {
      const tag = /^<\/?[A-Za-z][\w:-]*/.exec(rest)
      if (tag !== null) { push(tokens, 'tag', tag[0]); at += tag[0].length; continue }
    }
    const number = /[\w$]/.test(line[at - 1] ?? '') ? null : NUMBER.exec(rest)
    if (number !== null) { push(tokens, 'number', number[0]); at += number[0].length; continue }
    const word = WORD.exec(rest)
    if (word !== null) {
      const text = word[0]
      const after = rest.slice(text.length).trimStart()
      const kind: TokenKind = language.keywords.has(text)
        ? 'keyword'
        : after.startsWith('(')
          ? 'call'
          : /^[A-Z][a-z0-9]/.test(text) && language.markup !== true
            ? 'type'
            : 'plain'
      push(tokens, kind, text)
      at += text.length
      continue
    }
    push(tokens, 'plain', line[at] ?? '')
    at += 1
  }
  return tokens
}

/** Where a string opened by `quote` closes in `text` (just past it), or -1. */
function closingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue }
    if (text.startsWith(quote, i)) return i + quote.length
  }
  return -1
}

/** One side of a file, line by line. Unknown languages come back as plain text. */
export function highlightLines(lines: string[], language: string | null): Token[][] {
  const spec = language === null ? undefined : LANGUAGES[language]
  if (spec === undefined) return lines.map((line) => (line === '' ? [] : [{ kind: 'plain', text: line }]))
  const state: State = { comment: false, quote: null }
  return lines.map((line) => tokenizeLine(line, spec, state))
}
