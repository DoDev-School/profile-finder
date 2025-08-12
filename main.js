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

    // 2) Enriquecer perfis EM LOTE e salvar somente os campos pedidos
    const outDs = await Actor.openDataset();

    // lista de usernames (sem duplicar / vazios)
    const allUsernames = candidates
        .map(c => (c.username || '').trim())
        .filter(Boolean);

    log.info(`Enriquecendo ${allUsernames.length} perfis em lote…`);

    // Chamada única ao profile scraper
    const profileItems = await callAndGetItems('apify/instagram-profile-scraper', {
        usernames: allUsernames,                 // <- lote de perfis
        proxy,
        sessionid: instagramSession || undefined // <- opcional, melhora estabilidade
    });

    // Indexa perfis por username (minúsculo)
    const profilesByUser = new Map();
    for (const item of profileItems) {
        // alguns retornos trazem "username", outros só "url"
        const key =
            (item?.username ||
                (item?.url && item.url.split('/').filter(Boolean).pop()) ||
                '').toLowerCase();
        if (!key) continue;
        profilesByUser.set(key, item);
    }

    // (opcional) para escolher uma hashtag "principal" respeitando a ordem do input
    const inputTagOrder = new Map(tags.map((t, i) => [t, i]));

    // percorre candidatos e salva somente os aprovados por seguidores
    let accepted = 0;

    for (const cand of candidates) {
        if (accepted >= maxProfiles) break;

        const uname = (cand.username || '').trim();
        const key = uname.toLowerCase();
        const p = profilesByUser.get(key);
        if (!p) continue;

        const followers = p.followersCount ?? p.followers ?? 0;
        if (followers < minFollowers) continue;

        // nicho a partir do Instagram (se houver)
        const niche = p.category_name ?? p.category ?? null;

        // hashtag pesquisada (principal): a 1ª do input que também está nas capturas deste usuário
        const matchedSet = new Set([...(cand.hashtagsMatched || [])].map(s => s.toLowerCase()));
        let principalTag = null;
        for (const t of tags) {
            if (matchedSet.has(t)) { principalTag = t; break; }
        }
        // fallback: se nada casou, pega a primeira hashtag do input
        if (!principalTag) principalTag = tags[0] || null;

        const itemOut = {
            // Campos EXIGIDOS:
            "perfil": `@${uname}`,                               // @username
            "hashtag_pesquisada": principalTag,                  // hashtag principal
            "seguidores": followers,                             // número de seguidores
            "nicho": niche,                                      // nicho (category_name do IG)
            "link_perfil": `https://www.instagram.com/${uname}/` // link do perfil

            // (opcionais úteis – pode remover se quiser)
            // , "nome": p.fullName ?? p.full_name ?? null,
            // , "hashtags_pesquisadas": Array.from(matchedSet)
        };

        await outDs.pushData(itemOut);
        accepted++;

        log.info(`Aceito (${accepted}/${maxProfiles}): ${itemOut.perfil} | Seguidores: ${followers} | Hashtag: #${principalTag}`);
    }

    log.info(`Concluído. Perfis aprovados: ${accepted}`);


} catch (err) {
    log.exception ? log.exception(err, 'Falha na execução') : log.error(err);
    throw err;
} finally {
    await Actor.exit();
}
