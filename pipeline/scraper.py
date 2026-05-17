import requests
from bs4 import BeautifulSoup
from openai import OpenAI
import json
import time
import re
import os

# ── Grok client (OpenAI-compatible) ──────────────────────────────────────────
grok = OpenAI(
    api_key=os.environ.get("GROK_API_KEY", "placeholder_key"),
    base_url="https://api.x.ai/v1"
)

# ── Browser-spoofing headers (bypasses 403 on mangaepisodeguide.com) ─────────
# Matches Chrome 148 on Windows 10 x64 exactly.
BROWSER_HEADERS = {
    "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                 "AppleWebKit/537.36 (KHTML, like Gecko) "
                                 "Chrome/148.0.0.0 Safari/537.36",
    "Accept":                    "text/html,application/xhtml+xml,application/xml;"
                                 "q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept-Encoding":           "gzip, deflate, br",
    "Sec-Ch-Ua":                 '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "Sec-Ch-Ua-Mobile":          "?0",
    "Sec-Ch-Ua-Platform":        '"Windows"',
    "Sec-Fetch-Dest":            "document",
    "Sec-Fetch-Mode":            "navigate",
    "Sec-Fetch-Site":            "none",
    "Sec-Fetch-User":            "?1",
    "Upgrade-Insecure-Requests": "1",
}

# ── Tier 1: mangaepisodeguide.com ─────────────────────────────────────────────
#
# The site has TWO different table layouts depending on the anime:
#
# FORMAT A — Arc-level  (JJK, Chainsaw Man, Vinland Saga, …)
#   columns: [0] Arc name  [1] Episode range  [2] Chapter range  [3] Type
#   cells[0] is NOT a number — it's a text arc name like "Introduction Arc"
#   One row = one arc.  We expand linearly into per-episode entries.
#
# FORMAT B — Per-episode  (Demon Slayer, …)
#   columns: [0] Ep#  [1] Title  [2] Chapter range  [3] Type
#   cells[0] IS a pure integer — the episode number.
#   One row = one episode.  Direct mapping.

def _parse_range(text: str) -> tuple[int, int] | None:
    """Parse '12–34', '12-34', or '12'  →  (12, 34) or (12, 12). Returns None on failure."""
    text = text.strip().replace("\u2013", "-").replace("\u2014", "-")  # en/em-dash → hyphen
    m = re.match(r"^(\d+)\s*[-]\s*(\d+)$", text)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"^(\d+)$", text)
    if m:
        v = int(m.group(1))
        return v, v
    return None


def fetch_mangaepisodeguide(page_slug: str) -> dict[int, dict]:
    """
    Fetch data from mangaepisodeguide.com.
    Auto-detects Format A (arc-level) vs Format B (per-episode).
    Returns {episode_int: {chapter_start, chapter_end}}.
    """
    url = f"https://mangaepisodeguide.com/{page_slug}"
    try:
        resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
        resp.encoding = 'utf-8'   # force UTF-8; site serves UTF-8 but may advertise latin-1
        if resp.status_code != 200:
            print(f"  [MEG] HTTP {resp.status_code} for {url}")
            return {}

        soup = BeautifulSoup(resp.text, "html.parser")
        mappings: dict[int, dict] = {}

        rows = soup.select("tbody#tableBody tr")
        if not rows:
            rows = soup.select("tbody tr")  # fallback
        if not rows:
            print(f"  [MEG] no table rows found on {url}")
            return {}

        # ── Detect format using first data row ──────────────────────────────
        first_cells = rows[0].find_all("td") if rows else []
        is_per_episode = (
            len(first_cells) >= 1
            and re.match(r"^\d+$", first_cells[0].get_text(strip=True))
        )

        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 3:
                continue

            try:
                if is_per_episode:
                    # ── Format B: cells[0]=Ep#, cells[2]=Chapter range ──────
                    ep_num = int(cells[0].get_text(strip=True))
                    ch_range = _parse_range(cells[2].get_text(strip=True))
                    if ch_range is None:
                        continue
                    mappings[ep_num] = {
                        "chapter_start": ch_range[0],
                        "chapter_end":   ch_range[1],
                    }
                else:
                    # ── Format A: cells[1]=Ep range, cells[2]=Chapter range ─
                    ep_range = _parse_range(cells[1].get_text(strip=True))
                    ch_range = _parse_range(cells[2].get_text(strip=True))
                    if ep_range is None or ch_range is None:
                        continue

                    ep_start, ep_end     = ep_range
                    ch_start, ch_end_all = ch_range
                    ep_count = max(1, ep_end - ep_start + 1)
                    ch_count = ch_end_all - ch_start + 1

                    # Distribute chapters proportionally across episodes in arc
                    for i in range(ep_count):
                        ep_num        = ep_start + i
                        this_ch_start = ch_start + round(i       * ch_count / ep_count)
                        this_ch_end   = ch_start + round((i + 1) * ch_count / ep_count) - 1
                        this_ch_start = max(ch_start, min(this_ch_start, ch_end_all))
                        this_ch_end   = max(ch_start, min(this_ch_end,   ch_end_all))
                        mappings[ep_num] = {
                            "chapter_start": this_ch_start,
                            "chapter_end":   this_ch_end,
                        }

            except (ValueError, IndexError):
                continue

        fmt = "per-episode" if is_per_episode else "arc-level"
        print(f"  [MEG] {url} -> {fmt} format, {len(mappings)} eps parsed")
        return mappings

    except Exception as e:
        print(f"  [MEG] fetch failed: {e}")
        return {}


# ── Tier 2: animefillerlist.com ───────────────────────────────────────────────
def fetch_animefillerlist(slug: str) -> dict[int, str]:
    try:
        url = f"https://www.animefillerlist.com/shows/{slug}"
        resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
        soup = BeautifulSoup(resp.text, "html.parser")
        result: dict[int, str] = {}
        for row in soup.select("table.EpisodeList tr"):
            cells = row.find_all("td")
            if not cells or not cells[0].get_text(strip=True).isdigit():
                continue
            ep = int(cells[0].get_text(strip=True))
            classes = row.get("class", [])
            if "filler" in classes:
                result[ep] = "filler"
            elif "mixed" in classes:
                result[ep] = "mixed"
            else:
                result[ep] = "canon"
        return result
    except Exception as e:
        print(f"  [animefillerlist] failed: {e}")
        return {}


# ── Tier 3: Fandom wiki ───────────────────────────────────────────────────────
def fetch_fandom_wiki(wiki_slug: str, episode_num: int) -> str | None:
    patterns = [
        f"Episode_{episode_num}",
        f"Episode {episode_num}",
        f"Ep._{episode_num}",
    ]
    for pattern in patterns:
        url = f"https://{wiki_slug}.fandom.com/wiki/{pattern}"
        try:
            resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, "html.parser")
                content = soup.select_one(".mw-parser-output")
                if content:
                    return content.get_text(" ", strip=True)[:3000]
        except Exception:
            continue
    return None


# ── Tier 4: Reddit search ─────────────────────────────────────────────────────
def search_reddit(anime_title: str, episode_num: int) -> str | None:
    queries = [
        f"{anime_title} episode {episode_num} manga chapter",
        f"{anime_title} ep {episode_num} chapters covered",
    ]
    headers = {"User-Agent": "MangaBridge/1.0 (pipeline bot)"}

    for query in queries:
        try:
            url = f"https://www.reddit.com/r/anime/search.json?q={requests.utils.quote(query)}&restrict_sr=1&sort=relevance&limit=3"
            resp = requests.get(url, headers=headers, timeout=10)
            data = resp.json()
            posts = data.get("data", {}).get("children", [])

            text_chunks = []
            for post in posts[:2]:
                pd = post["data"]
                text_chunks.append(pd.get("title", ""))
                text_chunks.append(pd.get("selftext", "")[:500])

            combined = " ".join(text_chunks)
            if combined.strip():
                return combined[:2000]
        except Exception:
            continue
    return None


# ── Tier 5: Grok extraction / inference ──────────────────────────────────────
EXTRACT_PROMPT = """You are a manga-to-anime episode mapping expert.

Given this text about {anime_title} Episode {episode_num}, extract the manga chapter range it covers.

Text:
{text}

Reply ONLY with valid JSON, no explanation:
{{
  "chapter_start": <int or null>,
  "chapter_end": <int or null>,
  "confidence": "high" | "medium" | "low"
}}

Rules:
- If chapters are mentioned explicitly, use them
- If a range like "chapters 30-32" appears, use it
- If only one chapter is mentioned, set both start and end to that number
- If you cannot determine chapters at all, return nulls with confidence "low"
"""

INFER_PROMPT = """You are a manga-to-anime episode mapping expert with deep knowledge of anime adaptations.

Based on your knowledge, what manga chapters does {anime_title} Episode {episode_num} cover?

Reply ONLY with valid JSON, no explanation:
{{
  "chapter_start": <int or null>,
  "chapter_end": <int or null>,
  "confidence": "high" | "medium" | "low",
  "notes": "<any adaptation notes like filler scenes, skipped content, etc. or empty string>"
}}
"""

def grok_extract(text: str, anime_title: str, episode_num: int) -> dict | None:
    try:
        prompt = EXTRACT_PROMPT.format(
            anime_title=anime_title,
            episode_num=episode_num,
            text=text
        )
        resp = grok.chat.completions.create(
            model="grok-2-latest",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=150,
            temperature=0
        )
        raw = resp.choices[0].message.content.strip()
        return json.loads(raw)
    except Exception as e:
        print(f"  [grok_extract] failed: {e}")
        return None


def grok_infer(anime_title: str, episode_num: int) -> dict:
    try:
        prompt = INFER_PROMPT.format(
            anime_title=anime_title,
            episode_num=episode_num
        )
        resp = grok.chat.completions.create(
            model="grok-2-latest",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=200,
            temperature=0
        )
        raw = resp.choices[0].message.content.strip()
        result = json.loads(raw)
        result["source"] = "ai_inferred"
        return result
    except Exception:
        return {
            "chapter_start": None,
            "chapter_end":   None,
            "confidence":    "low",
            "source":        "ai_inferred",
            "notes":         ""
        }


# ── Core: resolve one episode through the waterfall ──────────────────────────
def resolve_episode(anime: dict, ep_num: int,
                    meg_data: dict, afl_data: dict) -> dict:

    chapter_start = None
    chapter_end   = None
    source        = "unknown"
    confidence    = "low"
    notes         = []

    if ep_num in meg_data:
        chapter_start = meg_data[ep_num]["chapter_start"]
        chapter_end   = meg_data[ep_num]["chapter_end"]
        source        = "mangaepisodeguide"
        confidence    = "high"
        print(f"    Ep {ep_num}: T1 hit ({chapter_start}-{chapter_end})")
    else:
        print(f"    Ep {ep_num}: trying fandom wiki…")
        wiki_text = fetch_fandom_wiki(anime["wiki_slug"], ep_num)
        if wiki_text:
            extracted = grok_extract(wiki_text, anime["title"], ep_num)
            if extracted and extracted.get("chapter_start"):
                chapter_start = extracted["chapter_start"]
                chapter_end   = extracted["chapter_end"]
                confidence    = extracted.get("confidence", "medium")
                source        = "fandom_wiki"
                print(f"    Ep {ep_num}: T3 hit ({chapter_start}-{chapter_end}, {confidence})")

        if not chapter_start:
            print(f"    Ep {ep_num}: trying Reddit…")
            reddit_text = search_reddit(anime["title"], ep_num)
            if reddit_text:
                extracted = grok_extract(reddit_text, anime["title"], ep_num)
                if extracted and extracted.get("chapter_start"):
                    chapter_start = extracted["chapter_start"]
                    chapter_end   = extracted["chapter_end"]
                    confidence    = extracted.get("confidence", "medium")
                    source        = "reddit"
                    print(f"    Ep {ep_num}: T4 hit ({chapter_start}-{chapter_end}, {confidence})")

        if not chapter_start:
            print(f"    Ep {ep_num}: falling back to Grok inference…")
            inferred      = grok_infer(anime["title"], ep_num)
            chapter_start = inferred.get("chapter_start")
            chapter_end   = inferred.get("chapter_end")
            confidence    = inferred.get("confidence", "low")
            source        = "ai_inferred"
            if inferred.get("notes"):
                notes.append(inferred["notes"])
            print(f"    Ep {ep_num}: T5 ({chapter_start}-{chapter_end}, {confidence})")

        time.sleep(0.5)

    filler_type = afl_data.get(ep_num, "canon")

    if source == "ai_inferred" and confidence == "low":
        notes.append("Chapter range unverified — may be approximate")

    return {
        "chapters":      [chapter_start, chapter_end],
        "continue_from": (chapter_end + 1) if chapter_end else None,
        "filler_type":   filler_type,
        "source":        source,
        "confidence":    confidence,
        "notes":         notes
    }


# ── Anime config ──────────────────────────────────────────────────────────────
# meg_slug : exact path on mangaepisodeguide.com (verified 2026-05)
ANIME_LIST = [
    {
        "key":            "jujutsu_kaisen",
        "title":          "Jujutsu Kaisen",
        "aliases":        ["jujutsu kaisen", "jjk"],
        "meg_slug":       "jjk.html",            # format A (arc-level)
        "afl_slug":       "jujutsu-kaisen",
        "wiki_slug":      "jujutsu-kaisen",
        "total_episodes": 24,
    },
    {
        "key":            "chainsaw_man",
        "title":          "Chainsaw Man",
        "aliases":        ["chainsaw man", "csm"],
        "meg_slug":       "csm.html",             # format A (arc-level)
        "afl_slug":       "chainsaw-man",
        "wiki_slug":      "chainsaw-man",
        "total_episodes": 12,
    },
    {
        "key":            "demon_slayer",
        "title":          "Demon Slayer",
        "aliases":        ["demon slayer", "kimetsu no yaiba", "kny"],
        "meg_slug":       "demonslayer.html",     # format B (per-episode)
        "afl_slug":       "demon-slayer-kimetsu-no-yaiba",
        "wiki_slug":      "kimetsu-no-yaiba",
        "total_episodes": 26,
    },
    {
        "key":            "vinland_saga",
        "title":          "Vinland Saga",
        "aliases":        ["vinland saga"],
        "meg_slug":       "vinlandsaga.html",     # format A (arc-level) — confirm if needed
        "afl_slug":       "vinland-saga",
        "wiki_slug":      "vinland-saga",
        "total_episodes": 24,
    },
]


# == Main ==
def build_mappings():
    output = {}

    for anime in ANIME_LIST:
        print(f"\n=== {anime['title']} ===")
        meg_data = fetch_mangaepisodeguide(anime["meg_slug"])
        afl_data = fetch_animefillerlist(anime["afl_slug"])
        print(f"  MEG: {len(meg_data)} eps | AFL: {len(afl_data)} eps")

        episodes = {}
        for ep in range(1, anime["total_episodes"] + 1):
            episodes[str(ep)] = resolve_episode(anime, ep, meg_data, afl_data)
            time.sleep(0.3)

        output[anime["key"]] = {
            "title":   anime["title"],
            "aliases": anime["aliases"],
            "seasons": {"1": {"episodes": episodes}}
        }

    os.makedirs("src/data", exist_ok=True)
    with open("src/data/mappings.json", "w") as f:
        json.dump(output, f, indent=2)
    print("\n[OK] mappings.json updated")


if __name__ == "__main__":
    build_mappings()
