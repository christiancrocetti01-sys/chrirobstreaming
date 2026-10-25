# ChriRob Watch Party

Guardate lo stesso film in due, da due PC diversi, perfettamente sincronizzati:
quando uno preme **play**, **pausa** o sposta la barra, lo stesso succede all'altro.
Niente più conto alla rovescia.

Funziona con **qualsiasi sito** che usa un normale player video HTML5. Visto che
lo script non è legato a un indirizzo preciso, **continua a funzionare anche quando
il sito cambia dominio**: non c'è niente da aggiornare.

## Perché uno script e non un sito?

Un sito "contenitore" non può controllare il player di un altro sito (il browser lo
vieta per sicurezza). Uno *userscript* invece gira direttamente dentro la pagina del
film, quindi può leggere e comandare il video.

## Installazione (una volta sola, su entrambi i PC)

1. Installate l'estensione **Tampermonkey** nel browser
   ([Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo),
   [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/),
   [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)).
2. Su Chrome/Edge: in `chrome://extensions` attivate la **Modalità sviluppatore**
   (e, se compare, l'opzione "Consenti script utente" nei dettagli di Tampermonkey).
3. Aprite il file [`watchparty.user.js`](watchparty.user.js) in versione *Raw*:
   Tampermonkey proporrà l'installazione → **Installa**.

## Come si usa

1. Entrambi aprite lo stesso film/episodio.
2. Quando il player è caricato compare in alto a destra il riquadro **Watch Party**.
3. Uno dei due clicca **Crea stanza** e ottiene un codice di 6 lettere (es. `K7QXPA`).
4. L'altro scrive il codice e clicca **Entra**. Il pallino diventa verde.
5. Da qui in poi chiunque dei due può mettere play, pausa o andare avanti/indietro.

Altre cose utili:

- **Riallinea**: forza l'altro PC alla tua posizione, se qualcosa sembra fuori sincrono.
  Comunque ogni 4 secondi chi ha creato la stanza corregge in automatico scarti
  superiori a 1,5 secondi.
- **Cambio episodio**: aprite il prossimo episodio entrambi; lo script rientra da solo
  nella stessa stanza.
- **Esci**: chiude la stanza e la dimentica.
- Cliccando sul titolo del riquadro lo riducete a icona.
- Se il browser blocca l'avvio automatico, comparirà un avviso: basta cliccare play
  una volta.

## Come funziona

La connessione è diretta tra i due browser (WebRTC tramite [PeerJS](https://peerjs.com)):
il server pubblico di PeerJS serve solo a farvi "trovare" con il codice, poi passano
solo piccoli messaggi tipo "play al secondo 1234". Il video lo scarica ognuno per conto
suo, come al solito. Si possono collegare anche più di due persone alla stessa stanza.
