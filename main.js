import { Actor, log } from '@apify/actor';

/**
 * Este actor orquestra scrapers oficiais da Store (mais estáveis do que endpoints diretos):
 * - apify/instagram-hashtag-scraper  → coleta posts por hashtag
 * - apify/instagram-profile-scraper  → coleta dados do perfil + posts recentes
 *
 * Fluxo:
 * 1) Para cada hashtag, coleta uma amostra de posts e agrega autores únicos.
 * 2) Para cada autor, busca dados do perfil (seguidores, verificado, bio) e N posts recentes.
 * 3) Calcula a taxa de acerto de hashtag (quantos dos N posts contêm qualquer hashtag do input).
 * 4) Filtra por seguidores >= minFollowers e hitRate >= minHashtagHitRate.
 * 5) Salva no dataset.
 */

await Actor.init();

try {
  const {
    hashtags,
    maxProfiles = 100,
    minFollowers = 1000,
    lookbackPosts = 20,
    minHashtagHitRate = 0.2,
    perHashtagPostSample = 200,
    useApifyProxy = true,
    proxyGroups = [],
    instagramSession
  } = await Actor.getInput() || {};

  if (!hashtags?.length) {
    throw new Error('Informe pelo menos uma hashtag em "hashtags".');
  }

  const proxyConfig = useApifyProxy
    ? { useApifyProxy: true, apifyProxyGroups: proxyGroups?.length ? proxyGroups : undefined }
    : undefined;

  // 1) Descobrir autores a partir das hashtags
  /** @type {Map<string, { username: string, samplePostIds: Set<string>, hashtagsMatched: Set<string> }>} */
  const authors = new Map();

  for (const tag of hashtags) {
    log.info(`Coletando posts para #${tag}...`);

    const runInput = {
      hashtags: [tag],
      resultsLimit: perHashtagPostSample,
      proxy: proxyConfig,
      // Se tiver sessão, passa:
      directUrls: [],
      sessionid: instagramSession || undefined
    };

    // Chama o scraper de hashtag da Store
    const hashtagRun = await Actor.call('apify/instagram-hashtag-scraper', runInput, {
      memoryMbytes: 1024
    });

    // Lê o dataset de saída desse run
    const { defaultDatasetId } = hashtagRun;
    const client = Actor.newClient();
    const ds = client.dataset(defaultDatasetId);

    let itemCount = 0;
    await ds.forEach(async (item) => {
      itemCount++;
      // Cada item é um post; pegue o autor/username
      const username = item?.ownerUsername || item?.username || item?.user?.username;
      if (!username) return;

      const postId = item?.shortCode || item?.id || item?.postId || '';
      const rec = authors.get(username) || {
        username,
        samplePostIds: new Set(),
        hashtagsMatched: new Set()
      };

      if (postId) rec.samplePostIds.add(postId);
      rec.hashtagsMatched.add(tag);
      authors.set(username, rec);
    });

    log.info(`Hashtag #${tag}: ${itemCount} posts processados, autores únicos até agora: ${authors.size}`);
  }

  // Ordena autores por "popularidade" nas hashtags (quantos posts/quantas hashtags)
  const sortedCandidates = [...authors.values()]
    .sort((a, b) => {
      const aScore = a.samplePostIds.size + a.hashtagsMatched.size * 2;
      const bScore = b.samplePostIds.size + b.hashtagsMatched.size * 2;
      return bScore - aScore;
    })
    .slice(0, maxProfiles * 3); // pega um buffer para filtrar depois

  log.info(`Candidatos para validação detalhada: ${sortedCandidates.length}`);

  const dataset = await Actor.openDataset();

  let accepted = 0;
  for (const cand of sortedCandidates) {
    if (accepted >= maxProfiles) break;

    // 2) Buscar dados do perfil + posts recentes
    const profileInput = {
      usernames: [cand.username],
      resultsLimit: lookbackPosts,
      proxy: proxyConfig,
      sessionid: instagramSession || undefined
    };

    const profRun = await Actor.call('apify/instagram-profile-scraper', profileInput, {
      memoryMbytes: 1024
    });

    const { defaultDatasetId: profDsId } = profRun;
    const client = Actor.newClient();
    const ds = client.dataset(profDsId);

    let profile = null;
    /** @type {{ caption?: string, url?: string }[]} */
    const recentPosts = [];

    await ds.forEach(async (item) => {
      // O scraper geralmente retorna primeiro o perfil, depois posts
      if (item?.type === 'profile' || item?.userId || item?.followersCount !== undefined) {
        profile = item;
      } else if (item?.type === 'post' || item?.shortCode || item?.caption) {
        recentPosts.push({
          caption: item?.caption || '',
          url: item?.url || item?.postUrl || (item?.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : undefined)
        });
      }
    });

    if (!profile) {
      log.warning(`Perfil não encontrado ou bloqueado: @${cand.username}`);
      continue;
    }

    const followers = profile.followersCount ?? profile.followers ?? 0;
    if (followers < minFollowers) {
      log.debug(`Descartado por seguidores: @${cand.username} (${followers})`);
      continue;
    }

    // 3) Calcular taxa de uso das hashtags nos posts recentes
    const tagSet = new Set(hashtags.map((h) => h.toLowerCase()));
    const containsTag = (text) => {
      if (!text) return false;
      const lower = text.toLowerCase();
      // Faz match simples por #tag com e sem acentos/variações básicas
      for (const t of tagSet) {
        if (lower.includes(`#${t}`)) return true;
        // fallback: presença da palavra (pode gerar falso-positivo, mas ajuda)
        if (lower.includes(t)) return true;
      }
      return false;
    };

    const analyzed = recentPosts.slice(0, lookbackPosts);
    const hits = analyzed.filter((p) => containsTag(p.caption)).length;
    const hitRate = analyzed.length ? hits / analyzed.length : 0;

    if (hitRate < minHashtagHitRate) {
      log.debug(`Descartado por baixa taxa de hashtag: @${cand.username} (${(hitRate * 100).toFixed(1)}%)`);
      continue;
    }

    // 4) Salvar
    const out = {
      username: cand.username,
      full_name: profile.fullName ?? profile.full_name ?? null,
      profile_url: `https://www.instagram.com/${cand.username}/`,
      followers,
      following: profile.followingCount ?? null,
      is_verified: profile.isVerified ?? null,
      biography: profile.biography ?? null,
      external_url: profile.externalUrl ?? null,
      recent_hashtag_hit_rate: hitRate,
      hashtags_matched_initial: [...cand.hashtagsMatched],
      recent_posts_analyzed: analyzed.length,
      recent_sample: analyzed.slice(0, 5),
      scraped_at: new Date().toISOString()
    };

    await dataset.pushData(out);
    accepted++;

    log.info(`Aceito (${accepted}/${maxProfiles}): @${cand.username} | Followers: ${followers} | HitRate: ${(hitRate * 100).toFixed(1)}%`);
  }

  log.info(`Concluído. Perfis salvos no dataset: ${accepted}`);
} catch (err) {
  log.exception(err, 'Falha na execução');
  throw err;
} finally {
  await Actor.exit();
}
