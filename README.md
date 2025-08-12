# Hashtag → Perfis (com filtro por seguidores)

Este actor encontra **perfis que usam uma ou mais hashtags** e filtra por:
- **Seguidores mínimos** (ex.: ≥ 1.000)
- **Taxa de uso das hashtags** nos posts recentes (ex.: ≥ 20%)

Ele **orquestra scrapers oficiais** da Apify Store (mais estáveis):
- `apify/instagram-hashtag-scraper` (coleta posts por hashtag)
- `apify/instagram-profile-scraper` (dados do perfil e posts recentes)

## Entrada (INPUT)
- `hashtags` (array, obrigatório): Ex. `["modafeminina", "acessorios"]`
- `maxProfiles` (int, padrão 100): Máximo de perfis a retornar
- `minFollowers` (int, padrão 1000): Seguidores mínimos
- `lookbackPosts` (int, padrão 20): Quantos posts recentes por perfil analisar
- `minHashtagHitRate` (0–1, padrão 0.2): Ex.: 0.2 = 20%
- `perHashtagPostSample` (int, padrão 200): Amostra de posts por hashtag para mapear autores
- `useApifyProxy` (bool, padrão true)
- `proxyGroups` (array de strings, opcional): Ex.: `["RESIDENTIAL"]`
- `instagramSession` (string, opcional): valor de `sessionid` do cookie do Instagram

## Saída (Dataset)
Cada item contém:
- `username`, `full_name`, `profile_url`
- `followers`, `following`, `is_verified`
- `biography`, `external_url`
- `recent_hashtag_hit_rate`, `hashtags_matched_initial`
- `recent_posts_analyzed`, `recent_sample[]`
- `scraped_at`

## Como usar
1. Faça o deploy no seu projeto Apify (ou suba como novo Actor).
2. Preencha o INPUT com as hashtags (sem `#`).
3. (Opcional) Forneça `instagramSession` para melhorar resultados.
4. Rode. Os perfis aprovados estarão no **dataset de saída**.

## Notas
- A validação de relevância **não depende só da busca por hashtag**; também verificamos os **posts recentes** do perfil e medimos a taxa de posts contendo suas hashtags.
- Para maior volume/robustez, mantenha `useApifyProxy: true` e considere `RESIDENTIAL`.

