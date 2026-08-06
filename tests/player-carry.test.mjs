// The carry is per-source, it is MEASURED, and two of the three sources say
// "I cannot carry" by NOT DEFINING loadArtist. That absence is load-bearing
// control flow — remountFor's `canCarry` tests for the method, and without it
// the player takes the teardown-and-rebuild path — but an absence leaves no
// trace in the code for a reader to trip over. It reads as an oversight, and
// the obvious "improvement" is to add the method back.
//
// It has already been added back once. buildSpotify shipped a loadArtist on the
// reasoning that reusing the controller must preserve the iOS gesture unlock
// "exactly as it does for the other two". Inference, not measurement, and the
// device disagreed (design/ios-playback-probe, source=Spotify, 2026-08-05).
//
// So this suite guards the absences. It cannot execute the adapters — they need
// a DOM plus a cross-origin SDK that CI has no business fetching — so it asserts
// against the source, in the same spirit as docs-truth.test.mjs. A structural
// check that fails loudly beats a correctness rule that lives only in a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/discovery/player.js', import.meta.url), 'utf8');

// The body of one top-level `function name(...) {` inside player.js, by brace
// balance. Brace-counting rather than a regex because these bodies contain
// nested functions, object literals and template strings, and a lazy match
// would stop at the first '}' it met.
function bodyOf(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `player.js no longer defines ${name}() — this guard needs updating, not deleting`);
  // Walk the PARAMETER list to its closing paren first. Every one of these
  // functions destructures its last argument (`{ setReady, onError }`), so the
  // first '{' after the name opens the params, not the body — take that one and
  // you extract four characters of nothing and the guard passes vacuously.
  // (It did. The YouTube positive-control test below is what caught it, which
  // is the entire reason a guard suite needs one.)
  let i = src.indexOf('(', start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

// A returned adapter method, not a mention: `loadArtist:` as a property.
// Comments explaining the absence are the point of this file and must not trip it.
function definesLoadArtist(body) {
  const withoutComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  return /(^|[\s,{])loadArtist\s*:/.test(withoutComments);
}

test('SoundCloud does not define loadArtist — the widget re-gates behind its own interstitial', () => {
  assert.equal(definesLoadArtist(bodyOf('buildSoundCloud')), false,
    'buildSoundCloud must NOT define loadArtist. Measured on an iPhone 2026-08-04: '
    + 'widget.load() then play() gives PLAY -> PAUSE at 0ms, PLAY_PROGRESS never fires, '
    + 'and the widget draws SoundCloud\'s own "Play on SoundCloud / Listen in browser" gate. '
    + 'Carrying anyway leaves a live widget wearing that interstitial, which is worse than a '
    + 'fresh one that takes one tap.');
});

test('Spotify does not define loadArtist — loadUri navigates the iframe out from under the unlock', () => {
  assert.equal(definesLoadArtist(bodyOf('buildSpotify')), false,
    'buildSpotify must NOT define loadArtist. Measured on an iPhone 2026-08-05, twice, on fresh '
    + 'pages with the 27s preview nowhere near its end: loadUri keeps the same <iframe> NODE but '
    + 'CHANGES ITS SRC. That is a navigation, the new document has never been touched, and neither '
    + 'an immediate play() nor a delayed one is honored. Note the trap — for a few seconds after '
    + 'the navigation the OLD document keeps playing and its playhead keeps climbing, which reads '
    + 'as a successful carry to anything judging on movement. Judge on the playhead RESTARTING.');
});

// The other half of the rule: YouTube DOES carry, and deleting its loadArtist
// would silently cost the one source that works. Same measurement, opposite sign.
test('YouTube DOES define loadArtist — it is the one source that carries', () => {
  assert.equal(definesLoadArtist(bodyOf('buildYouTube')), true,
    'buildYouTube must define loadArtist. Measured on an iPhone 2026-08-04: loadVideoById into '
    + 'the live player keeps the unlock — same iframe, playhead advancing, no new tap. Removing it '
    + 'would route the only carryable source through a needless rebuild.');
});
