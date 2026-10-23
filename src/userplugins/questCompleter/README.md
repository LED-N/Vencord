# CompleteDiscordQuests

Catalogue des quêtes Discord classé par récompense, avec une file d'attente modifiable et la récupération des récompenses. Anciennement « Quest Auto Completer » : les réglages sont migrés automatiquement.

> L'automatisation des quêtes est contraire aux conditions de Discord, qui sanctionne ces pratiques depuis avril 2026. Les « objectifs d'activité » sont le mode le plus risqué.

## Utilisation

- **Bouton** : près des réglages du compte, dans la barre de titre, les deux, ou flottant (réglage « Emplacement »). Pastille rouge : quêtes disponibles. Pastille verte : récompenses prêtes à être récupérées. Pendant une quête, un anneau autour du logo montre la progression.
- **Menu** : un bandeau résume les Orbs à gagner, les récompenses à récupérer et la durée de la file. Les onglets filtrent par récompense, avec recherche et tri (dont « Plus d'Orbs d'abord »). Les cartes affichent le visuel de la quête, la récompense mise en avant, le type de tâche, la durée, l'échéance (en orange sous 48 h) et la progression.
- **Nitro** : les abonnés Nitro voient le montant d'Orbs de Discord (`premiumOrbQuantity`) avec la pastille « ×1,2 », comme sur la page des quêtes. Si Discord n'envoie pas de montant Nitro, rien n'est inventé.
- **File** : « Lancer » accepte la quête si nécessaire et démarre son traitement ; pendant une quête, « Ajouter à la file ». ↑ et ✕ réorganisent la file, avec le temps restant de chaque quête. « Tout ajouter » suit les filtres des réglages.
- **Récupération** : automatique par défaut, ou via « Récupérer » / « Tout récupérer ». Elle passe par le parcours natif de Discord (vérification du compte, captcha humain, confirmation). Le menu s'efface pendant ce temps puis revient tel quel.
- **Réglages** : ⚙ dans le menu, ou les réglages du plugin dans Vencord.
- Si **BetterNotifications** est activé, les quêtes terminées sont annoncées dans son overlay, visible en jeu.
- « Reprendre la file » restaure la file après un redémarrage. Les statistiques (quêtes terminées, Orbs récupérés) sont conservées localement.

## Objectifs d'activité

Un ajout manuel demande une confirmation **valable pour cette quête seulement**. Les ajouts groupés et automatiques exigent le réglage « Objectifs d'activité ». Accepter une quête n'active plus ce réglage.

## Organisation

- `catalog.ts` : fonctions pures (normalisation, tâches, récompenses et Orbs, visuels, file). Testées par `catalog.test.ts`.
- `selectors.ts` : vues calculées partagées (catalogue affiché, compteurs, Nitro, durée de la file).
- `state.ts` : état partagé entre le moteur et l'interface, avec un rendu regroupé par micro-tâche.
- `index.tsx` : moteur (une boucle de heartbeat commune à toutes les tâches), patches des boutons, cycle de vie.
- `ui/` : interface React (bouton, menu, cartes, réglages, dialogues, toasts). `rewards.tsx` : récupération native. `native.ts` : requêtes vers l'activité.

## Ressources

- Aucun `MutationObserver` permanent : les boutons sont intégrés à Discord par des patches, compatibles avec VencordToolbox et GameActivityToggle. Seule la récupération observe temporairement les fenêtres de Discord.
- Aucune interrogation périodique au repos. Il n'y a qu'un abonnement au store des quêtes et un réveil ponctuel à la prochaine date de début ou d'expiration.
- Le rendu est regroupé : plusieurs changements dans la même tâche donnent un seul rendu. Les visuels sont chargés à la demande (`loading="lazy"`).
- Un seul traitement de quête à la fois, car le jeu simulé et la session d'activité sont des ressources partagées.

## Vérification

```sh
node --import tsx src/userplugins/questCompleter/catalog.test.ts
pnpm testTsc
pnpm lint src/userplugins/questCompleter
pnpm exec stylelint src/userplugins/questCompleter/styles.css
```
