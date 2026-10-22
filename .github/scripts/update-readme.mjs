// Refreshes the numbers that go stale: the header stats in README.md, the star
// counts of the repos I contributed to and my project count in
// CONTRIBUTIONS.md, and the star counts of my own projects in PROJECTS.md,
// where new public repos are also added. Run by
// .github/workflows/update-readme.yml.
//
// The markdown files stay the source of truth: rows are updated in place, so
// hand edits (categories, "Built with", demo links) survive. Repos that are not
// in any category yet land in the generated block between the new-projects
// markers; move a row out of it into a category to keep your edits.

import { readFile, writeFile } from 'node:fs/promises'

const USER = 'fzn0x'
const README = new URL('../../README.md', import.meta.url)
const CONTRIBUTIONS = new URL('../../CONTRIBUTIONS.md', import.meta.url)
const PROJECTS = new URL('../../PROJECTS.md', import.meta.url)
const MERGED_PRS_QUERY = `is:pr author:${USER} is:merged -user:${USER}`
const NEW_START = '<!-- new-projects:start -->'
const NEW_END = '<!-- new-projects:end -->'

async function gh(path) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/${path}`, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}: ${await res.text()}`)
  return res.json()
}

async function ownedRepos() {
  const repos = []
  for (let page = 1; ; page++) {
    const batch = await gh(`users/${USER}/repos?type=owner&per_page=100&page=${page}`)
    repos.push(...batch)
    if (batch.length < 100) return repos.filter((r) => !r.fork)
  }
}

// 32612 -> "32.6k", 960 -> "960", matching the hand-written counts.
const compact = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`)
const parseCompact = (s) => (s.endsWith('k') ? parseFloat(s) * 1000 : Number(s))
const cell = (s) => s.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
const starBadge = (n) => `![stars](https://img.shields.io/badge/stars-${n}-f5c518?style=flat-square&logo=github)`

const load = async (file) => (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
let readme = await load(README)
let contributions = await load(CONTRIBUTIONS)
let projects = await load(PROJECTS)
const original = { readme, contributions, projects }

// Header stats
const [user, repos, merged] = await Promise.all([
  gh(`users/${USER}`),
  ownedRepos(),
  gh(`search/issues?q=${encodeURIComponent(MERGED_PRS_QUERY)}&per_page=1`),
])
const totalStars = repos.reduce((sum, r) => sum + r.stargazers_count, 0)
readme = readme
  .replace(/(img\.shields\.io\/badge\/followers-)\d+/, `$1${user.followers}`)
  .replace(/(img\.shields\.io\/badge\/stars-)\d+(-0D1117)/, `$1${totalStars}$2`)
  .replace(/(img\.shields\.io\/badge\/merged_PRs-)\d+(-0D1117)/, `$1${merged.total_count}$2`)

// Stars of the repos I contributed to: the featured cards and the table
const FEATURED = /(\*\*\[[^\]]+\]\(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pulls[^)]*\)\*\*(?:(?!<\/td>)[\s\S])*?img\.shields\.io\/badge\/stars-)([\d.]+k?)/g
const CONTRIB_ROW = /^\| \[([\w.-]+\/[\w.-]+)\]\(https:\/\/github\.com\/[^)]+\) \| ([\d.]+k?) \|/

const slugs = new Set([...contributions.matchAll(FEATURED)].map((m) => m[2]))
for (const line of contributions.split('\n')) {
  const m = line.match(CONTRIB_ROW)
  if (m) slugs.add(m[1])
}
const stars = new Map()
for (const slug of slugs) {
  const repo = await gh(`repos/${slug}`)
  if (repo) stars.set(slug, repo.stargazers_count)
  else console.warn(`skipping ${slug}: not found`)
}

contributions = contributions.replace(FEATURED, (all, head, slug) => (stars.has(slug) ? head + compact(stars.get(slug)) : all))

const lines = contributions.split('\n')
for (let i = 0; i < lines.length; i++) {
  if (!CONTRIB_ROW.test(lines[i])) continue
  let end = i
  while (end < lines.length && CONTRIB_ROW.test(lines[end])) end++
  const rows = lines.slice(i, end).map((line) => {
    const [, slug, old] = line.match(CONTRIB_ROW)
    const n = stars.get(slug) ?? parseCompact(old)
    return { n, line: stars.has(slug) ? line.replace(`| ${old} |`, `| ${compact(n)} |`) : line }
  })
  rows.sort((a, b) => b.n - a.n)
  lines.splice(i, rows.length, ...rows.map((r) => r.line))
  i = end
}
contributions = lines.join('\n')

const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
contributions = contributions.replace(/Star counts as of \w+ \d{4}/, `Star counts as of ${month}`)

// My Projects
const PROJECT_ROW = new RegExp(`^\\| \\*\\*\\[([\\w.-]+)\\]\\(https://github\\.com/${USER}/\\1\\)\\*\\*`)
const byName = new Map(repos.map((r) => [r.name, r]))

function updateProjectRow(line) {
  const repo = byName.get(line.match(PROJECT_ROW)[1])
  if (!repo) return line
  const [first, description, builtWith] = line.trimEnd().slice(1, -1).split(/(?<!\\)\|/).map((s) => s.trim())
  const [title, ...rest] = first.split('<br>')
  const links = rest.filter((part) => !part.startsWith('![stars]'))
  const parts = [title, ...(repo.stargazers_count > 0 ? [starBadge(repo.stargazers_count)] : []), ...links]
  const desc = repo.description ? cell(repo.description) : description
  return `| ${parts.join('<br>')} | ${desc} | ${builtWith} |`
}

async function newProjectRow(repo) {
  const languages = Object.keys((await gh(`repos/${repo.full_name}/languages`)) ?? {}).slice(0, 5)
  const parts = [`**[${repo.name}](${repo.html_url})**`]
  if (repo.stargazers_count > 0) parts.push(starBadge(repo.stargazers_count))
  if (repo.homepage && !repo.homepage.includes(`github.com/${USER}/${repo.name}`)) parts.push(`[Website](${repo.homepage})`)
  return `| ${parts.join('<br>')} | ${cell(repo.description ?? '')} | ${languages.map((l) => `\`${l}\``).join(' ')} |`
}

const blockStart = projects.indexOf(NEW_START)
const blockEnd = projects.indexOf(NEW_END)
if (blockStart < 0 || blockEnd < 0) throw new Error(`PROJECTS.md is missing the ${NEW_START} / ${NEW_END} markers`)
projects = projects.slice(0, blockStart + NEW_START.length) + projects.slice(blockEnd)

projects = projects
  .split('\n')
  .map((line) => (PROJECT_ROW.test(line) ? updateProjectRow(line) : line))
  .join('\n')

const listed = new Set(projects.split('\n').flatMap((line) => line.match(PROJECT_ROW)?.[1] ?? []))
const fresh = repos
  .filter((r) => !r.archived && r.name !== USER && !listed.has(r.name))
  .sort((a, b) => b.created_at.localeCompare(a.created_at))
let block = ''
if (fresh.length) {
  const rows = await Promise.all(fresh.map(newProjectRow))
  block = `\n## New\n\n| Project | Description | Built with |\n| :--- | :--- | :--- |\n${rows.join('\n')}\n\n`
}
projects = projects.replace(NEW_START, () => NEW_START + block)

const projectCount = projects.split('\n').filter((line) => PROJECT_ROW.test(line)).length
contributions = contributions.replace(/\d+ public projects/, `${projectCount} public projects`)

const changed = [
  [README, readme, original.readme],
  [CONTRIBUTIONS, contributions, original.contributions],
  [PROJECTS, projects, original.projects],
].filter(([, text, before]) => text !== before)

if (!changed.length) {
  console.log('Profile is up to date')
} else {
  for (const [file, text] of changed) await writeFile(file, text)
  console.log(`Updated: ${totalStars} stars, ${user.followers} followers, ${merged.total_count} merged PRs, ${projectCount} projects`)
}
