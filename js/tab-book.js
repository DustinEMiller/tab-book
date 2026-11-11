/*
 * RockTab Tab Book: script
 *
 * Reads the tab book data (packed into the page, locked with a passphrase on the web
 * site, or in tabs.json beside it), builds the song list, and draws the open song as
 * tab, chords or a lyric sheet. Play walks a cursor along the tab at the song's speed.
 */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let data = null, song = null, key = null, list = -1, rows = [], perRow = 4;
  // Playlists folded shut, by name, kept between visits; the one with the song open is always unfolded.
  let folded = new Set();
  try { folded = new Set(JSON.parse(store.get('folded') || '[]')); } catch {}
  let time = 0, playing = false, lastFrame = 0, speed = Number(store.get('speed') || 1), wake = null;
  // The view: the tab, the song's chords section by section, or the lyric sheet; kept between visits.
  let view = ['tab', 'chords', 'sheet'].includes(store.get('view')) ? store.get('view') : 'tab';
  // The lyric sheet with the chords written over the words; kept between visits.
  let sheetChords = store.get('sheetChords') === 'on';

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}, text) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---- The words: syllables put back together into words and lines ----
  // [{ t, text, first }] in the order sung: a word is its syllables run together, first is the first word of a line.
  function wordsOf(s) {
    const out = [];
    let word = null, lineStart = true;
    for (const [t, text, flags] of s.lyrics || []) {
      if (!word) { word = { t, text: '', first: lineStart }; }
      word.text += text;
      lineStart = false;
      if (!(flags & 1)) { out.push(word); word = null; }
      if (flags & 2) { if (word) { out.push(word); word = null; } lineStart = true; }
    }
    if (word) out.push(word);
    return out;
  }
  // [{ t, text }]: each line as sung, its words joined by spaces.
  function linesOf(s) {
    const lines = [];
    for (const w of wordsOf(s)) {
      if (w.first || !lines.length) lines.push({ t: w.t, text: w.text });
      else lines[lines.length - 1].text += ' ' + w.text;
    }
    return lines;
  }
  // The bar a time falls in (the first bar for anything before it).
  function barAt(t) {
    let b = 0;
    while (b + 1 < song.bars.length && t >= song.bars[b + 1] - 0.001) b++;
    return b;
  }
  const hasLyrics = s => !!(s && s.lyrics && s.lyrics.length);

  // The link to a song: its artist then its title, in plain lower-case letters and digits joined by "-"
  // (#metallica-seek-and-destroy). Two songs that would share one get -2, -3 after the second and later.
  let slugs = null;
  function slugOf(k) {
    if (!slugs) {
      slugs = {};
      const used = {};
      for (const [key, s] of Object.entries(data.songs)) {
        const base = `${s.artist || ''} ${s.title || ''}`.normalize('NFKD').replace(/[̀-ͯ]/g, '')
          .toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'song';
        used[base] = (used[base] || 0) + 1;
        slugs[key] = used[base] > 1 ? `${base}-${used[base]}` : base;
      }
    }
    return slugs[k] || k;
  }

  // ---- The song rail: each playlist, its songs in order, each playlist folding shut under its name ----
  function buildRail() {
    const lists = $('lists');
    lists.textContent = '';
    data.playlists.forEach((pl, li) => {
      const ul = document.createElement('ul');
      ul.className = 'songs';
      ul.id = `list-${li}`;
      const h = document.createElement('button');
      h.className = 'list-name';
      h.dataset.list = li;
      h.setAttribute('aria-controls', ul.id);
      h.innerHTML = '<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="name"></span><span class="count"></span>';
      h.querySelector('.name').textContent = pl.name;
      h.querySelector('.count').textContent = pl.songs.filter(k => data.songs[k]).length;
      h.addEventListener('click', () => fold(li, h.getAttribute('aria-expanded') === 'true'));
      pl.songs.forEach((k, i) => {
        const s = data.songs[k];
        if (!s) return;
        const item = document.createElement('li');
        const b = document.createElement('button');
        b.dataset.key = k;
        b.dataset.list = li;
        b.innerHTML = `<span class="n">${i + 1}</span><span><span class="t"></span><span class="by"></span></span>`;
        b.querySelector('.t').textContent = s.title;
        b.querySelector('.by').textContent = s.artist;
        // Shown in the lyric sheet: a song with no words, in red, flagged.
        if (!hasLyrics(s)) {
          b.classList.add('no-lyrics');
          const flag = document.createElement('span');
          flag.className = 'flag';
          flag.textContent = '⚠ Missing lyrics';
          b.querySelector('.by').after(flag);
        }
        b.addEventListener('click', () => { open(k, li); closeRail(); });
        item.append(b);
        ul.append(item);

      });
      lists.append(h, ul);
      showFold(li, !folded.has(pl.name));
    });
  }

  function showFold(li, open) {
    const h = document.querySelector(`.list-name[data-list="${li}"]`);
    h.setAttribute('aria-expanded', String(open));
    $(`list-${li}`).hidden = !open;
  }

  function fold(li, shut) {
    const name = data.playlists[li].name;
    shut ? folded.add(name) : folded.delete(name);
    store.set('folded', JSON.stringify([...folded]));
    showFold(li, !shut);
  }

  // The song open, lit in its playlist, which is unfolded, and brought into view in the rail.
  function showCurrent() {
    document.querySelectorAll('.songs button').forEach(b => b.setAttribute('aria-current', String(b.dataset.key === key && Number(b.dataset.list) === list)));
    document.querySelectorAll('.list-name').forEach(h => h.classList.toggle('has-current', Number(h.dataset.list) === list));
    if (list < 0) return;
    if (folded.has(data.playlists[list].name)) fold(list, false);
    const b = document.querySelector(`.songs button[data-key="${CSS.escape(key)}"][data-list="${list}"]`);
    const r = $('rail');
    if (!b) return;
    // Centered in the rail when it is out of sight, or nearly so.
    const top = b.getBoundingClientRect().top - r.getBoundingClientRect().top + r.scrollTop, bottom = top + b.offsetHeight;
    if (top < r.scrollTop + 40 || bottom > r.scrollTop + r.clientHeight - 40)
      r.scrollTop = Math.max(0, top - (r.clientHeight - b.offsetHeight) / 2);
  }

  // ---- One song laid out in lines of bars ----
  // The playlist is the one it was picked from; otherwise the one it was last in, or the first that has it.
  function open(k, li) {
    if (!data.songs[k]) return;
    stop();
    key = k;
    const has = i => data.playlists[i]?.songs.includes(k);
    list = li ?? (has(list) ? list : has(Number(store.get('list'))) ? Number(store.get('list')) : data.playlists.findIndex(p => p.songs.includes(k)));
    song = data.songs[k];
    time = 0;
    store.set('song', k);
    store.set('list', String(list));
    try { history.replaceState(null, '', '#' + slugOf(k)); } catch {}
    showCurrent();
    $('title').textContent = song.title;
    const bars = song.bars.length;
    $('meta').textContent = [song.artist, song.part, song.tuning, song.bpm ? `${song.bpm} bpm` : '', `${bars} bars`].filter(Boolean).join(' · ');
    $('play').disabled = false;
    layout();
    $('sheet').scrollTop = 0;
    tick(true);
  }

  function barEnd(i) { return i + 1 < song.bars.length ? song.bars[i + 1] : song.length; }

  function layout() {
    const sheet = $('sheet');
    sheet.textContent = '';
    rows = [];
    if (!song) return;
    if (view === 'chords') { layoutChords(sheet); return; }
    if (view === 'sheet') { layoutSheet(sheet); return; }
    const width = sheet.clientWidth - 32;
    perRow = width >= 900 ? 4 : width >= 560 ? 3 : 2;
    const strings = song.strings.length;
    // The words always show under the tab, for a song that has them.
    const words = hasLyrics(song) ? wordsOf(song) : [];
    const gap = 14, top = 26, left = 22, height = top + (strings - 1) * gap + 22 + (words.length ? 36 : 0);
    // Notes by bar, chords kept together.
    const byBar = song.bars.map(() => []);
    let b = 0;
    for (const n of song.notes) {
      while (b + 1 < song.bars.length && n[0] >= song.bars[b + 1] - 0.001) b++;
      if (n[0] >= song.bars[0] - 0.001) byBar[b].push(n);
    }
    // The other instrument's notes, by bar: only in bars the part rests (the cues say so).
    const cuesByBar = song.bars.map(() => []);
    b = 0;
    for (const t of song.cues || []) {
      while (b + 1 < song.bars.length && t >= song.bars[b + 1] - 0.001) b++;
      if (t >= song.bars[0] - 0.001) cuesByBar[b].push(t);
    }
    // Section names at the first bar they start in.
    const sectionAt = {};
    for (const s of song.sections) {
      const i = song.bars.findIndex((t, j) => t >= s.start - 0.05 || (t <= s.start && barEnd(j) > s.start + 0.05));
      if (i >= 0 && !(i in sectionAt)) sectionAt[i] = s.name;
    }
    for (let first = 0; first < song.bars.length; first += perRow) {
      const count = Math.min(perRow, song.bars.length - first);
      const w = Math.max(240, width);
      const bw = (w - left) / perRow;
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const svg = el('svg', { viewBox: `0 0 ${w} ${height}`, height, role: 'img', 'aria-label': `Bars ${first + song.firstBar} to ${first + count - 1 + song.firstBar}` });
      const y = s => top + (strings - 1 - s) * gap;
      for (let s = 0; s < strings; s++) {
        svg.append(el('text', { class: 'sname', x: 2, y: y(s) + 4 }, song.strings[s]));
        svg.append(el('line', { class: 'string', x1: left, x2: left + bw * count, y1: y(s), y2: y(s) }));
      }
      for (let i = 0; i < count; i++) {
        const bar = first + i, x0 = left + i * bw;
        const hit = el('rect', { class: 'barhit', x: x0, y: top - 6, width: bw, height: (strings - 1) * gap + 12 });
        hit.addEventListener('click', () => { time = song.bars[bar]; tick(true); });
        svg.append(hit);
        svg.append(el('line', { class: 'barline', x1: x0, x2: x0, y1: y(strings - 1), y2: y(0) }));
        svg.append(el('text', { class: 'barno', x: x0 + 3, y: top - 10 }, String(bar + song.firstBar)));
        if (sectionAt[bar] !== undefined) svg.append(el('text', { class: 'section', x: x0 + (bar + song.firstBar >= 100 ? 26 : 20), y: top - 10 }, sectionAt[bar]));
        const t0 = song.bars[bar], t1 = barEnd(bar), pad = 10;
        const X = t => x0 + pad + Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) * (bw - 2 * pad);
        if (cuesByBar[bar].length) {
          svg.append(el('text', { class: 'cue-name', x: x0 + 6, y: y(strings - 1) + 11 }, song.cueName || 'Band'));
          const mid = (y(0) + y(strings - 1)) / 2 + 6;
          for (const t of cuesByBar[bar]) svg.append(el('circle', { class: 'cue', cx: X(t), cy: mid, r: 3 }));
        }
        for (const n of byBar[bar]) {
          const [t, s, f, sus, marks, slide] = n;
          if (s < 0 || s >= strings) continue;
          const x = X(t), yy = y(s);
          if (sus > 0.2) svg.append(el('line', { class: 'sustain', x1: x + 6, x2: Math.min(x0 + bw - 3, X(t + sus)), y1: yy, y2: yy }));
          if (slide >= 0) {
            const up = slide > f;
            svg.append(el('line', { class: 'slide', x1: x + 9, x2: x + 17, y1: yy + (up ? 4 : -4), y2: yy + (up ? -4 : 4) }));
          }
          const label = marks.includes('x') ? 'x' : marks.includes('n') ? `<${f}>` : String(f);
          const wch = 8 * label.length + 4;
          svg.append(el('rect', { class: 'fret-bg', x: x - wch / 2, y: yy - 8, width: wch, height: 16, rx: 3 }));
          svg.append(el('text', { class: 'fret', x, y: yy + 4.5, 'text-anchor': 'middle' }, label));
          const small = (marks.includes('h') ? 'h' : '') + (marks.includes('p') ? 'p' : '') + (marks.includes('b') ? 'b' : '')
            + (marks.includes('t') ? 'T' : '') + (marks.includes('s') ? 'S' : '') + (marks.includes('o') ? 'P' : '') + (marks.includes('v') ? '~' : '');
          if (small) svg.append(el('text', { class: 'mark', x: x - 4, y: yy - 10, 'text-anchor': 'end' }, small));
        }
      }
      svg.append(el('line', { class: 'barline', x1: left + count * bw, x2: left + count * bw, y1: y(strings - 1), y2: y(0) }));
      // The words sung in these bars, under the lowest string where each is sung. Two lines of words, so a busy
      // verse keeps its words near their notes: each word takes the first line free where it is sung, is pushed
      // along only when both are taken, and never runs past the end of the row.
      if (words.length) {
        const from = first === 0 ? -Infinity : song.bars[first], to = first + count < song.bars.length ? song.bars[first + count] : Infinity;
        const end = left + count * bw, free = [left, left];
        for (const w of words) {
          if (w.t < from - 0.001 || w.t >= to - 0.001) continue;
          const bar = barAt(w.t), i = bar - first, x0 = left + i * bw, t0 = song.bars[bar], t1 = barEnd(bar), pad = 10;
          const at = x0 + pad + Math.min(1, Math.max(0, (w.t - t0) / (t1 - t0))) * (bw - 2 * pad);
          const len = w.text.length * 6.6;
          const line = free[0] <= at - 3 ? 0 : free[1] <= at - 3 ? 1 : free[0] <= free[1] ? 0 : 1;
          const x = Math.min(Math.max(at - 3, free[line]), Math.max(left, end - len));
          svg.append(el('text', { class: w.first ? 'word first' : 'word', x, y: y(0) + 30 + line * 15 }, w.text));
          free[line] = x + len + 7;
        }
      }
      const cursor = document.createElement('div');
      cursor.className = 'cursor';
      cursor.hidden = true;
      cursor.style.height = `${(strings - 1) * gap + 16}px`;
      cursor.style.top = `${top - 8}px`;
      wrap.append(svg, cursor);
      sheet.append(wrap);
      rows.push({ wrap, cursor, first, count, left, bw, w });
    }
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Click any bar to start from it. The cursor follows the song at the speed chosen; there is no sound.';
    sheet.append(hint);
  }

  // ---- The chords: "Riff ×3  E G A C", in the order the song plays its sections ----
  function layoutChords(sheet) {
    const box = document.createElement('div');
    box.className = 'chords';
    const c = song.chords;
    if (!c || !c.form.length) {
      box.innerHTML = '<p class="empty"></p>';
      box.firstChild.textContent = c ? 'No chords could be worked out for this song.' : 'This copy of the tab book has no chords yet. RockTab adds them the next time it saves the tab book.';
      sheet.append(box);
      return;
    }
    const key = document.createElement('p');
    key.className = 'ckey';
    key.innerHTML = (c.key ? 'Key of <b></b> · ' : '') + 'Simplified for bass: the root, m for minor, a slash chord as its bass note.';
    if (c.key) key.querySelector('b').textContent = c.key;
    box.append(key);
    for (const part of c.form) {
      const s = document.createElement('div');
      s.className = 'cs';
      const name = document.createElement('div');
      name.className = 'cname';
      name.textContent = part.name;
      // A figure that is one chord held is so many bars of it, not a count of times through.
      const held = ([repeat, chords]) => chords.length === 1;
      // One figure in the section: its repeats and the section's run together, as "Riff ×3".
      const one = part.lines.length === 1 && !held(part.lines[0]);
      const times = part.times * (one ? part.lines[0][0] : 1);
      if (times > 1) {
        const t = document.createElement('span');
        t.className = 'times';
        t.textContent = `×${times}`;
        name.append(t);
      }
      const lines = document.createElement('div');
      for (const [repeat, chords, bars] of part.lines) {
        const line = document.createElement('div');
        line.className = 'cline';
        if (!one && repeat > 1 && chords.length > 1) {
          const r = document.createElement('span');
          r.className = 'rep';
          r.textContent = `×${repeat}`;
          line.append(r);
        }
        for (const ch of chords) {
          const span = document.createElement('span');
          span.className = ch === '–' ? 'ch rest' : 'ch';
          span.textContent = ch === '–' ? 'rest' : ch;
          line.append(span);
        }
        const length = (bars || 1) * repeat;
        if (chords.length === 1 && length > 1) {
          const r = document.createElement('span');
          r.className = 'rep';
          r.textContent = `${length} bars`;
          line.append(r);
        }
        lines.append(line);
      }
      s.append(name, lines);
      box.append(s);
    }
    sheet.append(box);
  }

  // Shows a view's button as pressed, and the controls that go with it (Play and the rest only with the tab).
  function showView() {
    document.querySelectorAll('.views button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $('controls').classList.toggle('not-tab', view !== 'tab');
    document.querySelector('.app').classList.toggle('sheet-view', view === 'sheet');
  }
  function setView(v) {
    if (v === view) return;
    view = v;
    store.set('view', v);
    showView();
    if (v !== 'tab') stop();
    layout();
    $('sheet').scrollTop = 0;
    if (v === 'tab') tick(true);
  }
  document.querySelectorAll('.views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  // ---- Printing the words: in the bars they fall in, or line by line ----
  const make = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  // The song's sections as runs of bars: [{ name, from, to }] (to is the bar after the last), in order.
  function sectionRuns() {
    const starts = [];
    for (const s of song.sections) {
      const i = song.bars.findIndex((t, j) => t >= s.start - 0.05 || (t <= s.start && barEnd(j) > s.start + 0.05));
      if (i >= 0 && !starts.some(x => x.from === i)) starts.push({ name: s.name, from: i });
    }
    starts.sort((a, b) => a.from - b.from);
    if (!starts.length || starts[0].from > 0) starts.unshift({ name: '', from: 0 });
    return starts.map((s, k) => ({ ...s, to: k + 1 < starts.length ? starts[k + 1].from : song.bars.length }));
  }

  // ---- The lyric sheet: the words section by section, as on a lyrics site, the chords over them if chosen ----
  // Each line's words, and each chord change placed over the word it comes on. A chord between lines (an intro, a
  // solo, a gap between verses) goes on a line of chords of its own.
  function sheetItems(withChords) {
    const lines = [];
    for (const w of wordsOf(song)) {
      if (w.first || !lines.length) lines.push({ t: w.t, words: [] });
      lines[lines.length - 1].words.push({ ...w, chords: [] });
    }
    const items = lines.map(l => ({ t: l.t, line: l }));
    if (withChords) {
      let gap = null;
      // Where each section after the first starts: a line of chords never runs on into the next section.
      const runStarts = sectionRuns().filter(r => r.from > 0).map(r => song.bars[r.from]);
      for (const [t, name] of song.chordTimes || []) {
        const L = lines.findIndex((l, k) => {
          const last = l.words[l.words.length - 1].t;
          const end = Math.min(k + 1 < lines.length ? lines[k + 1].t - 0.3 : Infinity, last + 1.5);
          return t >= l.t - 0.3 && t < end;
        });
        if (L >= 0) {
          const ws = lines[L].words;
          let i = 0;
          while (i + 1 < ws.length && ws[i + 1].t <= t + 0.15) i++;
          ws[i].chords.push(name);
          gap = null;
        } else {
          // A run of chords with no words: one line of them, until the words come back.
          if (!gap || lines.some(l => l.t > gap.t && l.t <= t) || runStarts.some(s => gap.t < s - 0.05 && t >= s - 0.05)) { gap = { t, chords: [] }; items.push(gap); }
          gap.chords.push(name);
        }
      }
    }
    return items.sort((a, b) => a.t - b.t);
  }

  // The sheet itself, for the screen and for printing.
  function buildSheet(withChords) {
    const box = make('div', 'lsheet-body');
    // A line of words starting up to half a bar early (a pickup) belongs to the section it leads into.
    const runs = sectionRuns().map(r => ({ ...r, start: r.from === 0 ? -Infinity : song.bars[r.from], lead: r.from > 0 ? (song.bars[r.from] - song.bars[r.from - 1]) / 2 : 0, items: [] }));
    for (const item of sheetItems(withChords)) {
      let k = runs.length - 1;
      while (k > 0 && item.t < runs[k].start - (item.line ? runs[k].lead : 0.05)) k--;
      runs[k].items.push(item);
    }
    for (const run of runs) {
      if (!run.items.length) continue;
      const sec = make('section', 'lsec');
      // No section names: a gap between sections is enough to see where one ends.
      for (const item of run.items) {
        if (item.chords) { sec.append(make('p', 'lchords', item.chords.join('  '))); continue; }
        if (!withChords) { sec.append(make('p', 'lline', item.line.words.map(w => w.text).join(' '))); continue; }
        const p = make('p', 'lline with-chords');
        for (const w of item.line.words) {
          const seg = make('span', 'seg');
          seg.append(make('span', 'cd', w.chords.join('  ') || ' '), make('span', 'wd', w.text));
          p.append(seg);
        }
        sec.append(p);
      }
      box.append(sec);
    }
    return box;
  }

  const sheetHasChords = () => !!(song.chordTimes && song.chordTimes.length);

  function layoutSheet(sheet) {
    const box = make('div', 'lsheet');
    if (!hasLyrics(song)) {
      box.append(make('p', 'warn', '⚠ The lyric file has no data.'));
      sheet.append(box);
      return;
    }
    const tools = make('div', 'ltools');
    if (sheetHasChords()) {
      const c = make('button', 'ghost', 'Lyrics + Chords');
      c.setAttribute('aria-pressed', String(sheetChords));
      c.title = 'Write each chord over the word it changes on, as on a chord chart';
      c.addEventListener('click', () => { sheetChords = !sheetChords; store.set('sheetChords', sheetChords ? 'on' : 'off'); layout(); });
      tools.append(c);
    }
    // Print: exactly what is shown, with the chords over the words if they are on.
    const print = make('button', 'ghost', 'Print');
    print.title = 'Print the lyric sheet as it is shown';
    print.addEventListener('click', printOut);
    tools.append(print);
    box.append(tools, buildSheet(sheetChords && sheetHasChords()));
    sheet.append(box);
  }

  // Prints the lyric sheet as it is shown: the title, then the words, with the chords over them if they are on.
  function printOut() {
    if (!hasLyrics(song)) return;
    const out = $('print');
    out.textContent = '';
    out.append(make('h1', '', song.title));
    out.append(make('p', 'pmeta', [song.artist, song.tuning, song.bpm ? `${song.bpm} bpm` : ''].filter(Boolean).join(' · ')));
    const sheetCopy = make('div', 'lsheet');
    sheetCopy.append(buildSheet(sheetChords && sheetHasChords()));
    out.append(sheetCopy);
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      removeEventListener('afterprint', done);
    };
    addEventListener('afterprint', done);
    // Laid out first, then printed. The class only matters to print: left on, the screen looks the same.
    requestAnimationFrame(() => window.print());
  }

  // ---- The play-along cursor ----
  let shownRow = -1;
  function tick(jump) {
    if (!song) return;
    $('clock').textContent = `${fmt(time)} / ${fmt(song.length)}`;
    let bar = 0;
    while (bar + 1 < song.bars.length && song.bars[bar + 1] <= time) bar++;
    const r = Math.floor(bar / perRow);
    rows.forEach((row, i) => { if (i !== r) row.cursor.hidden = true; });
    const row = rows[r];
    if (!row) return;
    const i = bar - row.first, t0 = song.bars[bar], t1 = barEnd(bar);
    const frac = Math.min(1, Math.max(0, (time - t0) / (t1 - t0)));
    const px = (row.left + i * row.bw + 10 + frac * (row.bw - 20)) / row.w * row.wrap.clientWidth;
    row.cursor.style.left = `${px - 1}px`;
    row.cursor.hidden = false;
    if (r !== shownRow || jump) {
      shownRow = r;
      const sheet = $('sheet');
      const target = row.wrap.offsetTop - sheet.offsetTop - 60;
      if (jump || Math.abs(sheet.scrollTop - target) > 40)
        sheet.scrollTo({ top: Math.max(0, target), behavior: jump || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  function frame(now) {
    if (!playing) return;
    time += (now - lastFrame) / 1000 * speed;
    lastFrame = now;
    if (time >= song.length) { time = song.length; tick(false); stop(); return; }
    tick(false);
    requestAnimationFrame(frame);
  }

  async function play() {
    if (!song || view !== 'tab') return;
    if (time >= song.length) time = 0;
    playing = true;
    $('play').textContent = 'Pause';
    lastFrame = performance.now();
    requestAnimationFrame(frame);
    try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  }
  function stop() {
    playing = false;
    $('play').textContent = 'Play';
    try { wake?.release(); } catch {}
    wake = null;
  }

  $('play').addEventListener('click', () => playing ? stop() : play());
  $('restart').addEventListener('click', () => { time = song ? song.bars[0] : 0; tick(true); });
  $('speedSel').value = String(speed);
  $('speedSel').addEventListener('change', e => { speed = Number(e.target.value); store.set('speed', String(speed)); });
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); playing ? stop() : play(); }
  });

  // ---- The song list: a drawer on phones; on a wide screen it folds away, kept so between visits ----
  const rail = $('rail'), menu = $('menu'), app = document.querySelector('.app');
  const narrow = () => matchMedia('(max-width: 760px)').matches;
  function closeRail() { rail.classList.remove('open'); menu.setAttribute('aria-expanded', String(!narrow() && !app.classList.contains('rail-shut'))); }
  function shutRail(shut) {
    app.classList.toggle('rail-shut', shut);
    store.set('rail', shut ? 'shut' : 'open');
    menu.setAttribute('aria-expanded', String(!shut));
    menu.title = shut ? 'Show the song list' : '';
    // The tab gets the width, or gives it back.
    if (song) { layout(); tick(true); }
    if (!shut) requestAnimationFrame(showCurrent);
  }
  if (store.get('rail') === 'shut') { app.classList.add('rail-shut'); menu.title = 'Show the song list'; }
  menu.addEventListener('click', () => {
    if (!narrow()) { shutRail(!app.classList.contains('rail-shut')); return; }
    const open = !rail.classList.contains('open');
    rail.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(showCurrent);
  });
  $('railHide').addEventListener('click', () => narrow() ? closeRail() : shutRail(true));

  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (song) { layout(); tick(true); } }, 150);
  });

  // ---- The web site's copy: locked with a passphrase, opened here in the browser ----
  const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function keyFrom(pass, lk) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: bytes(lk.salt), iterations: lk.rounds, hash: 'SHA-256' }, base, 256));
  }
  async function unseal(raw, lk) {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(lk.iv) }, key, bytes(lk.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  function unlock(lk) {
    // A phone that has opened it before keeps the key (never the passphrase) for this lock.
    const kept = store.get('key:' + lk.salt);
    const tryKept = kept ? unseal(bytes(kept), lk).catch(() => null) : Promise.resolve(null);
    return tryKept.then(d => d || new Promise(resolve => {
      $('title').textContent = 'Tab Book';
      $('made').textContent = 'Locked';
      $('controls').hidden = true;
      const form = document.createElement('form');
      form.className = 'unlock';
      form.innerHTML = '<p>These tabs are locked. Type the passphrase you chose in RockTab.</p>'
        + '<input type="password" autocomplete="current-password" aria-label="Passphrase" required>'
        + '<label><input type="checkbox" checked> Remember on this device</label>'
        + '<button class="play" type="submit">Open</button><p class="wrong" role="alert"></p>';
      const [pass, keep, go, wrong] = [form.querySelector('input[type=password]'), form.querySelector('input[type=checkbox]'), form.querySelector('button'), form.querySelector('.wrong')];
      pass.addEventListener('input', () => { wrong.textContent = ''; });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!pass.value) { wrong.textContent = 'Type the passphrase first.'; return; }
        go.disabled = true;
        go.textContent = 'Opening…';
        try {
          const raw = await keyFrom(pass.value, lk);
          const d = await unseal(raw, lk);
          if (keep.checked) store.set('key:' + lk.salt, btoa(String.fromCharCode(...raw)));
          $('controls').hidden = false;
          resolve(d);
        } catch {
          wrong.textContent = 'That is not the passphrase.';
          go.disabled = false;
          go.textContent = 'Open';
        }
      });
      $('sheet').textContent = '';
      $('sheet').append(form);
      pass.focus();
    }));
  }

  // The data: packed into the page itself (the copy RockTab saves to a folder), locked in it (the web site's copy),
  // or beside it (the published page).
  const packed = document.getElementById('tab-data'), locked = document.getElementById('tab-locked');
  (locked ? unlock(JSON.parse(locked.textContent)) : packed ? Promise.resolve(JSON.parse(packed.textContent)) : fetch('tabs.json').then(r => r.json())).then(d => {
    data = d;
    const count = Object.keys(d.songs).length;
    $('made').textContent = `${count} songs from your RockTab playlists, bass parts. Made ${d.made}.`;
    buildRail();
    showView();
    // A link names the song as artist then title (#metallica-seek-and-destroy); an older link by the song's key still works.
    const hash = decodeURIComponent(location.hash.slice(1));
    const wanted = d.songs[hash] ? hash : Object.keys(d.songs).find(k => slugOf(k) === hash);
    const first = d.playlists.find(l => l.songs.length)?.songs[0];
    open(d.songs[wanted] ? wanted : d.songs[store.get('song')] ? store.get('song') : first);
  }).catch(() => {
    $('title').textContent = 'The tabs could not be loaded';
    $('empty').textContent = 'Reload the page. If it keeps happening, ask Claude to publish the tab book again.';
  });
})();
