# GameSpoofer

Fait croire à Discord que tu joues à un jeu, choisi parmi tous ceux qu'il sait détecter. Tes amis voient « Joue à … » avec l'icône du jeu et le temps écoulé, exactement comme si Discord avait trouvé son exécutable.

## Utilisation

- **Bouton** (icône joystick) à côté des boutons micro / casque. Il devient vert pendant un faux jeu.
- **Clic** : ouvre la liste. Tape le nom d'un jeu (les alias de Discord marchent aussi, ex. « lol »), clique dessus : c'est lancé.
- **Clic droit** pendant un faux jeu, ou « Arrêter » dans la fenêtre : le jeu se « ferme ».
- Les derniers jeux choisis s'affichent quand la recherche est vide.
- Aussi accessible depuis les réglages du plugin (« Choisir un jeu »).

Si le partage d'activité est désactivé (bouton manette de GameActivityToggle), la fenêtre le signale et propose de le réactiver : sans lui, personne ne voit le jeu.

## Fonctionnement

Le faux jeu a la forme d'un jeu détecté, avec un chemin qui se termine par l'un des exécutables que Discord associe à ce jeu (ex. `c:/games/valorant/valorant.exe`). Il est injecté à trois endroits de Discord :

| Endroit | Effet |
| --- | --- |
| `RunningGameStore.getVisibleGame()` | Le statut « Joue à » partagé avec tes amis. |
| `RunningGameStore.getCurrentGameForAnalytics()` | L'événement `launch_game` au lancement (marqué « vérifié »), et le jeu en cours dans les heartbeats du client. |
| `RunningGameHeartbeatManager` | L'événement `running_game_heartbeat` au lancement, toutes les 5 minutes et à l'arrêt : c'est avec lui que Discord compte les heures jouées (voir l'option « allowBadgeTracking » de NoTrack). |

Ces événements alimentent, côté serveur, l'« Activité récente » et le temps de jeu du profil. Ils passent par les analytics de Discord : si NoTrack bloque les analytics sans l'option « allowBadgeTracking », rien n'est compté. Le faux jeu fournit sa propre empreinte d'exécutable pour que Discord l'accepte dans l'activité récente, même si le fichier n'existe pas sur le disque.

Le faux jeu n'est pas ajouté à `getRunningGames()` : les quêtes ne progressent pas avec lui, et ni l'overlay ni BetterNotifications ne le prennent pour un vrai jeu. Un vrai jeu lancé pendant ce temps reste masqué jusqu'à l'arrêt du faux.

Le faux jeu s'arrête à la fermeture de Discord ou à la désactivation du plugin. Seul l'arrêt (clic droit, bouton ou désactivation) envoie le heartbeat de fin : une fermeture de Discord en plein faux jeu revient à un crash du jeu.
