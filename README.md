# HODOU2 — هدوء

Prototype DigiSchool réalisé pour une équipe de 3 collégiens : aider la classe à adapter le niveau sonore à son activité.

## Utiliser l’application

- Interface en arabe et en français, avec grands textes et mode projection.
- Démonstration sans microphone, ou essai réel avec le microphone après autorisation.
- Choix de l’activité, du seuil relatif, de la durée et du délai d’alerte.
- Pause enseignant, historique local et export CSV des résumés.
- Version autonome téléchargeable depuis la page « Le projet ».

L’indice sonore va de 0 à 100. Il n’est pas une mesure acoustique calibrée en décibels. Les conversations ne sont ni enregistrées ni envoyées à un serveur. Les résumés restent dans le navigateur utilisé ; les démonstrations sont identifiées et exclues des comparaisons de séances réelles.

## Développement et publication

Avec Node.js installé :

```sh
npm test
npm run build
```

Aucune installation de dépendance n’est nécessaire. Le moteur est dans `src/engine.mjs`, les textes AR/FR dans `src/i18n.mjs`, le comportement dans `src/app.mjs` et le design dans `src/styles.css`.

Le build génère `docs/index.html` et `docs/hodou2.html`, avec la police arabe intégrée. GitHub Pages publie le dossier `/docs` de la branche `main`. Après une modification, relancer le build et inclure `docs/` dans le commit.

La police Noto Sans Arabic est distribuée selon la licence SIL Open Font License, fournie dans `src/fonts/OFL.txt`.
