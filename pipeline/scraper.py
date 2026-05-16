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

# ── Tier 1: mangaepisodeguide.com ─────────────────────────────────────────────
def fetch_mangaepisodeguide(slug: str) -> dict:
    try:
        url = f"https://mangaepisodeguide.com/{slug}"
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        if resp.status_code != 200:
            return {}
        soup = BeautifulSoup(resp.text, "html.parser")
        mappings = {}
        for row in soup.select("tbody tr"):
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            try:
                ep = int(cells[0].get_text(strip=True))
                ch_text = cells[2].get_text(strip=True)
                if "-" in ch_text:
                    a, b = ch_text.split("-")
                    ch_start, ch_end = int(a.strip()), int(b.strip())
                else:
                    ch_start = ch_end = int(re.sub(r"\D", "", ch_text))
                mappings[ep] = {"chapter_start": ch_start, "chapter_end": ch_end}
            except (ValueError, IndexError):
                continue
        return mappings
    except Exception as e:
        print(f"  [mangaepisodeguide] failed: {e}")
        return {}


# ── Tier 2: animefillerlist.com ───────────────────────────────────────────────
def fetch_animefillerlist(slug: str) -> dict:
    try:
        url = f"https://www.animefillerlist.com/shows/{slug}"
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        soup = BeautifulSoup(resp.text, "html.parser")
        result = {}
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
            resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
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
            "chapter_end": None,
            "confidence": "low",
            "source": "ai_inferred",
            "notes": ""
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
            inferred = grok_infer(anime["title"], ep_num)
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
        "chapters": [chapter_start, chapter_end],
        "continue_from": (chapter_end + 1) if chapter_end else None,
        "filler_type": filler_type,
        "source": source,
        "confidence": confidence,
        "notes": notes
    }


# ── Anime config ──────────────────────────────────────────────────────────────
ANIME_LIST = [
    {
        "key": "jujutsu_kaisen",
        "title": "Jujutsu Kaisen",
        "aliases": ["jujutsu kaisen", "jjk"],
        "meg_slug": "jujutsu-kaisen",
        "afl_slug": "jujutsu-kaisen",
        "wiki_slug": "jujutsu-kaisen",
        "total_episodes": 24,
    },
    {
        "key": "chainsaw_man",
        "title": "Chainsaw Man",
        "aliases": ["chainsaw man", "csm"],
        "meg_slug": "chainsaw-man",
        "afl_slug": "chainsaw-man",
        "wiki_slug": "chainsaw-man",
        "total_episodes": 12,
    },
    {
        "key": "demon_slayer",
        "title": "Demon Slayer",
        "aliases": ["demon slayer", "kimetsu no yaiba", "kny"],
        "meg_slug": "demon-slayer",
        "afl_slug": "demon-slayer-kimetsu-no-yaiba",
        "wiki_slug": "kimetsu-no-yaiba",
        "total_episodes": 26,
    },
    {
        "key": "vinland_saga",
        "title": "Vinland Saga",
        "aliases": ["vinland saga"],
        "meg_slug": "vinland-saga",
        "afl_slug": "vinland-saga",
        "wiki_slug": "vinland-saga",
        "total_episodes": 24,
    },
]


# ── Main ──────────────────────────────────────────────────────────────────────
def build_mappings():
    output = {}

    for anime in ANIME_LIST:
        print(f"\n── {anime['title']} ──")
        meg_data = fetch_mangaepisodeguide(anime["meg_slug"])
        afl_data = fetch_animefillerlist(anime["afl_slug"])
        print(f"  MEG: {len(meg_data)} eps | AFL: {len(afl_data)} eps")

        episodes = {}
        for ep in range(1, anime["total_episodes"] + 1):
            episodes[str(ep)] = resolve_episode(anime, ep, meg_data, afl_data)
            time.sleep(0.3)

        output[anime["key"]] = {
            "title": anime["title"],
            "aliases": anime["aliases"],
            "seasons": {"1": {"episodes": episodes}}
        }

    os.makedirs("src/data", exist_ok=True)
    with open("src/data/mappings.json", "w") as f:
        json.dump(output, f, indent=2)
    print("\n✅ mappings.json updated")


if __name__ == "__main__":
    build_mappings()
