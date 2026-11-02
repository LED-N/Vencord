# BetterNotifications — notifications en jeu

Dans les réglages du plugin, ouvre **En jeu → Écran en jeu → Écran des notifications en jeu**. Choisis un moniteur dans la liste, ou **Réglage habituel** pour conserver le choix de l'onglet Apparence. Le choix est enregistré avec l'identifiant du moniteur, et s'applique aussi aux cartes déjà affichées.

- Sur un écran différent de celui du jeu, les notifications restent visibles même si **Estomper** ou **Masquer** est sélectionné. La protection contre les clics accidentels en jeu ne s'applique pas à cet écran. Le réglage général des cartes cliquables et le mode de survol restent respectés.
- Sur le même écran que le jeu, les réglages **Ne rien faire / Estomper / Masquer** et **Verrouiller en jeu** continuent de s'appliquer.
- Si le moniteur choisi est débranché, le plugin utilise le réglage habituel. Le choix enregistré est conservé pour sa reconnexion.
- À la fermeture du dernier jeu détecté, le réglage habituel reprend.

Sous Windows, **Alt+Tab vers une autre application** ou l'ouverture du **menu Démarrer** suspend la protection des cartes tant que le jeu n'est plus au premier plan. Revenir au jeu rétablit la protection. Le raccourci de déverrouillage existant reste disponible et le mode fantôme conserve son délai de survol.

Le plugin évite d'intercepter les clics ; il ne confine pas lui-même le curseur. La libération effective du curseur lors d'un changement d'application reste gérée par Windows et le jeu.

Sous Windows, les cartes autorisées à recevoir des clics utilisent une fenêtre activable : cela permet les interactions successives après fermeture puis réaffichage, y compris sur un autre écran que Discord. L'apparition d'une notification utilise toujours `showInactive` et ne change pas le focus. Une carte verrouillée en jeu reste non activable ; un clic autorisé peut activer la fenêtre de notification.

La détection utilise les identifiants des processus des jeux fournis par Discord, sans les lanceurs ni les jeux simulés par Quest Completer. Un jeu absent de cette liste peut être ajouté pendant qu'il tourne depuis **En jeu → Détection des jeux**, ou dans les **Jeux enregistrés** de Discord. Un jeu ajouté que Discord ne connaît pas peut y être associé au vrai jeu : il prend son nom, et le profil affiche alors la fiche de ce jeu.

La distinction entre jeu au premier plan et jeu en arrière-plan utilise un processus PowerShell masqué pendant qu'un jeu est détecté. Il interroge les API Windows en lecture seule toutes les 150 ms, sans intercepter les touches ni modifier le confinement du curseur. Il est arrêté à la fin de la session de jeu, à la désactivation du plugin et à la fermeture normale de Discord. Si l'observation est indisponible ou ne répond plus, le verrouillage automatique est suspendu pour laisser les cartes accessibles. Hors Windows, la détection conserve son comportement antérieur fondé sur le focus de Discord.

Références : [fenêtre au premier plan](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow), [processus associé à une fenêtre](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid), [écrans et coordonnées Electron](https://www.electronjs.org/docs/latest/api/screen).

Vérifications automatisées :

```sh
node --test src/userplugins/betterNotifications.desktop/tests/native.test.mjs
```

Les interactions de la fenêtre (croix, glissements, mise à jour d'un message pendant un clic) ont aussi des tests dans `tests/overlay.test.mjs`. Pour les exécuter, définir `BROWSER_PATH` avec le chemin d'un navigateur Chromium ou Edge, puis lancer `node --test src/userplugins/betterNotifications.desktop/tests/overlay.test.mjs`.

Pour la validation dans Discord : lancer un jeu réel, essayer chaque écran avec Estomper puis Masquer, passer sur une autre application avec Alt+Tab et ouvrir le menu Démarrer, revenir au jeu, puis débrancher l'écran choisi. Vérifier aussi les configurations avec des facteurs d'échelle différents. Les tests automatisés simulent ces changements de fenêtre et d'écran ; ils ne remplacent pas cette vérification en jeu.
