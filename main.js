// main.js — usando SDK v3 (pacote: apify)
import { Actor, log } from 'apify';

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
        if (lower.includes(`#${t}`)) return true;
        if (lower.includes(t)) return true; // fallback sem '#'
    }
    return false;
}

async function fetchAllDatasetItems(client, datasetId, { limit = 1000 } = {}) {
    const ds = client.dataset(datasetId);
    let offset = 0;
    const all = [];
    // paginação segura
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { items, total } = await ds.listItems({ limit, offset });
        all.push(...items);
        offset += items.length;
        if (items.length === 0 || all.length >= total) break;
    }
    return all;
}

async function callAndGetItems(actorId, input) {
    const run = await Actor.call(actorId, input); // <-- sem options
    const client = Actor.newClient();
    return fetchAllDatasetItems(client, run.defaultDatasetId);
}

await Actor.init();

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
        instagramSession,
    } = (await Actor.getInput()) || {};

    if (!hashtags?.length) {
        throw new Error('Informe pelo menos uma hashtag em "hashtags".');
    }

    const tags = normTags(hashtags);
    const tagSet = new Set(tags);
    const minHashtagHitRate = Math.max(0, Math.min(100, minHashtagHitRatePct)) / 100;

    const proxy = useApifyProxy
        ? { useApifyProxy: true, apifyProxyGroups: proxyGroups?.length ? proxyGroups : undefined }
        : undefined;

    // 1) Descobrir autores a partir das hashtags
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

        log.info(`#${tag}: ${fromTag} posts mapeados | autores únicos: ${authorsMap.size}`);
        await sleep(500);
    }

    // priorizar candidatos
    const candidates = [...authorsMap.values()]
        .sort((a, b) => {
            const aScore = a.samplePostIds.size + a.hashtagsMatched.size * 2;
            const bScore = b.samplePostIds.size + b.hashtagsMatched.size * 2;
            return bScore - aScore;
        })
        .slice(0, maxProfiles * 3);

    log.info(`Candidatos para validação: ${candidates.length}`);

    // 2) Enriquecer perfis em LOTE + filtrar
    const outDs = await Actor.openDataset();

    // monte a lista de usernames (buffer para filtrar depois)
    const allUsernames = candidates.map(c => c.username).slice(0, maxProfiles * 3);

    // uma única chamada ao profile scraper com todos os perfis
    const profItems = await callAndGetItems('apify/instagram-profile-scraper', {
        usernames: allUsernames,
        resultsLimit: lookbackPosts,
        proxy,
        sessionid: instagramSession || undefined,
    });

    // agrupar por username
    const profilesByUser = new Map();
    const postsByUser = new Map();

    for (const item of profItems) {
        const uname = (item?.username || item?.ownerUsername || item?.owner?.username || '').toLowerCase();
        if (!uname) continue;

        // item de perfil?
        if (item?.followersCount !== undefined || item?.type === 'profile') {
            profilesByUser.set(uname, item);
            continue;
        }

        // item de post
        const arr = postsByUser.get(uname) || [];
        arr.push({
            caption: item?.caption || '',
            url: item?.url || item?.postUrl || (item?.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : undefined),
        });
        postsByUser.set(uname, arr);
    }

    // agora percorre candidatos e aplica filtros
    let accepted = 0;
    const picked = new Set();

    for (const cand of candidates) {
        if (accepted >= maxProfiles) break;

        const key = cand.username.toLowerCase();
        if (picked.has(key)) continue;

        const profile = profilesByUser.get(key);
        if (!profile) continue;

        const followers = profile.followersCount ?? profile.followers ?? 0;
        if (followers < minFollowers) continue;

        const analyzed = (postsByUser.get(key) || []).slice(0, lookbackPosts);
        const hits = analyzed.filter(p => containsAnyHashtag(p.caption, tagSet)).length;
        const hitRate = analyzed.length ? hits / analyzed.length : 0;

        if (hitRate < minHashtagHitRate) continue;

        await outDs.pushData({
            username: cand.username,
            full_name: profile.fullName ?? profile.full_name ?? null,
            profile_url: `https://www.instagram.com/${cand.username}/`,
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
        });

        picked.add(key);
        accepted++;
        log.info(`Aceito (${accepted}/${maxProfiles}): @${cand.username} | Followers: ${followers} | HitRate: ${(hitRate * 100).toFixed(1)}%`);
    }

    log.info(`Concluído. Perfis aprovados: ${accepted}`);

} catch (err) {
    log.exception ? log.exception(err, 'Falha na execução') : log.error(err);
    throw err;
} finally {
    await Actor.exit();
}
