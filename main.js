// main.js
import Apify from 'apify';

// log compatível independente da versão
const log = (Apify.utils && Apify.utils.log) || Apify.log || console;

/**
 * Helpers
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normTags(arr) {
  return (arr || [])
    .map((t) => String(t || '').trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

function containsAnyHashtag(text, tagSet) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const t of tagSet) {
    if (lower.includes(`#${t}`)) return true; // match exato com '#'
    // fallback: presença da palavra crua (ajuda quando a pessoa escreve sem '#')
    if (lower.includes(t)) return true;
  }
  return false;
}

async function fetchAllDatasetItems(client, datasetId, { limit = 1000 } = {}) {
  const ds = client.dataset(datasetId);
  let offset = 0;
  const all = [];
  while (true) {
    const { items, total } = await ds.listItems({ limit, offset });
    all.push(...items);
    offset += items.length;
    if (items.length === 0 || all.length >= total) break;
  }
  return all;
}

async function callAndGetItems(actorId, input, { memoryMbytes = 1024 } = {}) {
  const run = await Apify.call(actorId, input, { memoryMbytes });
  const client = Apify.newClient();
  return fetchAllDatasetItems(client, run.defaultDatasetId);
}

await Apify.init();

try {
  const {
    hashtags,
    maxProfiles = 100,
    minFollowers = 1000,
    lookbackPosts = 20,
    minHashtagHitRatePct = 20, // 0–100
    perHashtagPostSample = 200,
    useApifyProxy = true,
    proxyGroups = [],
    instagramSession, // valor do cookie 'sessionid' (opcional, mas ajuda)
  } = (await Apify.getInput()) || {};

  if (!hashtags?.length) {
    throw new Error('Informe pelo menos uma hashtag em "hashtags".');
  }

  const tags = normTags(hashtags);
  const tagSet = new Set(tags);
  const minHashtagHitRate = Math.max(0, Math.min(100, minHashtagHitRatePct)) / 100; // fração 0–1

  const proxy = useApifyProxy
    ? { useApifyProxy: true, apifyProxyGroups: proxyGroups?.length ? proxyGroups : undefined }
    : undefined;

  // --------------------------------------------------------------------
  // 1) Descobrir autores a partir das hashtags (posts recentes por hashtag)
  // --------------------------------------------------------------------
  /** @type {Map<string, { username: string, samplePostIds: Set<string>, hashtagsMatched: Set<string> }>} */
  const authorsMap = new Map();

  for (const tag of tags) {
    log.info(`Coletando posts para #${tag}...`);

    const hashtagInput = {
      hashtags: [tag],
      resultsLimit: perHashtagPostSample,
      proxy,
      sessionid: instagramSession || undefined,
    };

    const items = await callAndGetItems('apify/instagram-hashtag-scraper', hashtagInput);

    let fromTag = 0;
    for (const it of items) {
      const username =
        it?.ownerUsername || it?.username || it?.user?.username || it?.owner?.username;
      if (!username) continue;

      const postId = it?.shortCode || it?.id || it?.postId || '';
      const key = username.toLowerCase();

      const rec =
        authorsMap.get(key) ||
        { username, samplePostIds: new Set(), hashtagsMatched: new Set() };

      if (postId) rec.samplePostIds.add(postId);
      rec.hashtagsMatched.add(tag);

      authorsMap.set(key, rec);
      fromTag++;
    }

    log.info(
      `#${tag}: ${fromTag} posts mapeados | autores únicos acumulados: ${authorsMap.size}`,
    );

    // respiro para evitar throttling de runs em sequência
    await sleep(500);
  }

  // prioriza candidatos que apareceram mais na coleta
  const candidates = [...authorsMap.values()]
    .sort((a, b) => {
      const aScore = a.samplePostIds.size + a.hashtagsMatched.size * 2;
      const bScore = b.samplePostIds.size + b.hashtagsMatched.size * 2;
      return bScore - aScore;
    })
    .slice(0, maxProfiles * 3); // buffer para filtrar depois

  log.info(`Candidatos para validação: ${candidates.length}`);

  // --------------------------------------------------------------------
  // 2) Enriquecer perfis + validar seguidores e relevância por hashtag
  // --------------------------------------------------------------------
  const outDs = await Apify.openDataset();
  const picked = new Set();
  let accepted = 0;

  for (const cand of candidates) {
    if (accepted >= maxProfiles) break;
    const uname = cand.username;
    if (!uname || picked.has(uname.toLowerCase())) continue;

    const profileInput = {
      usernames: [uname],
      resultsLimit: lookbackPosts,
      proxy,
      sessionid: instagramSession || undefined,
    };

    const profItems = await callAndGetItems('apify/instagram-profile-scraper', profileInput);

    // O run retorna 1 item "profile" + N itens "post"
    let profile = null;
    /** @type {{ caption?: string; url?: string }[]} */
    const recentPosts = [];

    for (const item of profItems) {
      const type = item?.type || (item?.followersCount !== undefined ? 'profile' : undefined);
      if (type === 'profile') {
        profile = item;
      } else if (item?.caption || item?.shortCode || item?.url || item?.postUrl) {
        recentPosts.push({
          caption: item?.caption || '',
          url:
            item?.url ||
            item?.postUrl ||
            (item?.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : undefined),
        });
      }
    }

    if (!profile) {
      log.warning(`Perfil não encontrado/bloqueado: @${uname}`);
      continue;
    }

    const followers = profile.followersCount ?? profile.followers ?? 0;
    if (followers < minFollowers) {
      log.debug(`Descartado por seguidores: @${uname} (${followers})`);
      continue;
    }

    const analyzed = recentPosts.slice(0, lookbackPosts);
    const hits = analyzed.filter((p) => containsAnyHashtag(p.caption, tagSet)).length;
    const hitRate = analyzed.length ? hits / analyzed.length : 0;

    if (hitRate < minHashtagHitRate) {
      log.debug(
        `Descartado por baixa taxa de hashtag: @${uname} (${(hitRate * 100).toFixed(1)}%)`,
      );
      continue;
    }

    // Monta saída padronizada
    const out = {
      username: uname,
      full_name: profile.fullName ?? profile.full_name ?? null,
      profile_url: `https://www.instagram.com/${uname}/`,
      followers,
      following: profile.followingCount ?? null,
      is_verified: profile.isVerified ?? null,
      biography: profile.biography ?? null,
      external_url: profile.externalUrl ?? null,
      recent_hashtag_hit_rate: Number(hitRate.toFixed(2)), // 0–1
      hashtags_matched_initial: [...(cand.hashtagsMatched || [])],
      recent_posts_analyzed: analyzed.length,
      recent_sample: analyzed.slice(0, 5),
      scraped_at: new Date().toISOString(),
    };

    await outDs.pushData(out);
    picked.add(uname.toLowerCase());
    accepted++;

    log.info(
      `Aceito (${accepted}/${maxProfiles}): @${uname} | Followers: ${followers} | HitRate: ${(
        hitRate * 100
      ).toFixed(1)}%`,
    );
  }

  log.info(`Concluído. Perfis aprovados: ${accepted}`);
} catch (err) {
  (log.error ? log.error(err) : console.error(err));
  throw err;
} finally {
  await Apify.exit();
}
