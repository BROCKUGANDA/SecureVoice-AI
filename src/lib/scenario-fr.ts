import type { ScenarioKind, ScenarioMeta } from "./scenario-types";

/**
 * French (fr) script layer — one entry per event, aligned with the 17-event
 * timeline in buildScenario(). Entries may be plain strings or functions
 * receiving the case metadata (for templated lines). Missing entries fall back
 * to English at render time (fr ?? en), same contract as hi and ur.
 *
 * House style is the one the live call paths already use (`outreach-copy.ts`,
 * `voice/conversation.ts`, `compliance/policy.ts`): `vous` register throughout,
 * a space before : ; ! ? , « » for quoted speech, straight apostrophes, and an
 * em-dash where the English has one. Numbers stay in the digits the other
 * non-Arabic scripts use, so the deck's figures agree with the transcript;
 * merchants, card masks, case ids, risk scores and API field values are not
 * translated — only the words around them.
 */
export type FrLine = string | ((m: ScenarioMeta, first: string) => string);

export const FR_PACKS: Record<ScenarioKind, FrLine[]> = {
  /* ————————— CARD-NOT-PRESENT ————————— */
  card: [
    // e01 · alert
    "SIGNAL DE FRAUDE REÇU — carte •• 4417, paiement de 2,500.00 dirhams chez Electronics World, Dubaï. Score de risque 0.94 (critique). Une incohérence d'appareil et une vitesse de transaction anormale ont été détectées.",
    // e02 · queue
    "Alerte validée et enrichie. File d'attente en priorité P1 — SLA de contact client : 60 secondes.",
    // e03 · dial
    "Appel sortant passé au numéro enregistré +971 •• ••• 4567 (Ahmed Al-Rashid). Canal préchauffé, profil vocal français (FR-FR).",
    // e04 · connected
    "Appel connecté en 1.2 s. Enregistrement activé. L'assistant est verrouillé sur le français dès la première réponse détectée.",
    // e05 · intro
    (m) =>
      `Bonjour, je suis l'assistant de sécurité IA de votre banque ; j'appelle au sujet d'une activité récente sur votre compte. Cet appel est enregistré pour protéger votre compte. Est-ce bien ${m.customer} qui me parle ?`,
    // e06 · identity
    (m, first) => `Oui, c'est bien ${first}.`,
    // e07 · verify
    "Merci Ahmed. Pour vérifier votre identité, dites-moi lesquelles de ces opérations récentes vous reconnaissez : première — 45.50 dirhams chez Carrefour, le 15 septembre. deuxième — 120.00 dirhams chez Amazon, le 16 septembre. troisième — 2,500.00 dirhams chez Electronics World, aujourd'hui.",
    // e08 · verifyAns
    "Les deux premières sont bien de moi. Les 2,500 dirhams chez Electronics World — je n'ai pas effectué cet achat.",
    // e09 · verifyOk
    "Vérification réussie — 2 opérations sur 3 reconnues, challenge relevé sans aide. Sentiment : préoccupation légère. Aucun code PIN ni mot de passe demandé à aucun moment.",
    // e10 · confirm
    "Je comprends votre inquiétude, Ahmed. Confirmons-le clairement : vous n'avez PAS autorisé l'opération de 2,500.00 dirhams chez Electronics World — est-ce exact ?",
    // e11 · confirmAns
    "C'est exact. Ce n'était pas moi.",
    // e12 · protect
    "Pour vous protéger, je place maintenant un blocage temporaire sur votre carte se terminant par 4417. Cela empêche toute nouvelle opération non autorisée, et il peut être levé instantanément dès que votre compte est sécurisé.",
    // e13 · api
    "200 OK · staged — gel : temporaire · motif : soupçon de fraude · vérification : 2/3 réussie",
    // e14 · done
    "C'est fait — votre carte est bloquée. Je vous passe maintenant ma collègue Sara, spécialiste anti-fraude, qui va sécuriser votre compte et organiser votre carte de remplacement. Merci de rester en ligne.",
    // e15 · handoff
    (m) =>
      `Transfert chaud vers une spécialiste humaine (Sara H.) — contexte complet transmis : statut de la vérification, événement de fraude confirmé, confirmation de l'action, indicateurs de sentiment. Dossier ${m.caseId} créé.`,
    // e16 · audit
    "Journal d'audit scellé — enregistrement de l'appel, transcription intégrale, méthode de vérification et horodatage de l'action ajoutés au registre d'audit chaîné par hachage, que la base de données interdit de modifier.",
    // e17 · outcome
    (m) =>
      `RÉSOLU — du signal de fraude à une mesure de protection, staged dans la limite de cas de 60 secondes (simulation guidée, temps comprimé). Perte estimée évitée : ${m.preventedLoss.en}. Ancienne méthode : 38 minutes.`,
  ],

  /* ————————— ATM CASH-OUT ————————— */
  atm: [
    "SIGNAL DE FRAUDE REÇU — carte •• 9034, retrait d'espèces de 8,000.00 dirhams au distributeur automatique de Corniche Street, Abou Dhabi. Score de risque 0.97 (critique). Profil de carte clonée : empreinte de lecture magnétique et 3e tentative en 10 minutes.",
    "Alerte validée et enrichie. File d'attente en priorité P1 — SLA de contact client : 60 secondes.",
    "Appel sortant passé au numéro enregistré +971 •• ••• 7831 (Mariam Haddad). Canal préchauffé, profil vocal français (FR-FR). La carte est encore active — le retrait est en cours.",
    "Appel connecté en 1.1 s. Enregistrement activé. L'assistant est verrouillé sur le français dès la première réponse détectée.",
    (m) =>
      `Bonjour, je suis l'assistant de sécurité IA de votre banque ; j'appelle au sujet d'une activité récente sur votre compte. Cet appel est enregistré pour protéger votre compte. Est-ce bien ${m.customer} qui me parle ?`,
    (m, first) => `Oui, c'est bien ${first}.`,
    "Merci Mariam. Pour vérifier votre identité, dites-moi lesquelles de ces opérations récentes vous reconnaissez : première — 34.00 dirhams chez Spinneys, le 14 septembre. deuxième — 250.00 dirhams chez ADNOC, le 16 septembre. troisième — un retrait d'espèces de 8,000.00 dirhams sur Corniche Street, en cours à cet instant.",
    "Les deux premières sont bien de moi. Je ne suis devant aucun distributeur — je suis chez moi, à Charjah. Quelqu'un utilise ma carte !",
    "Vérification réussie — 2 opérations sur 3 reconnues, incohérence géographique confirmée (la cliente est enregistrée à Charjah). Sentiment : détresse aiguë. Escalade prioritaire activée. Aucun code PIN ni mot de passe demandé à aucun moment.",
    "Je vous crois, Mariam. Confirmons-le clairement : vous n'avez PAS autorisé le retrait de 8,000.00 dirhams au distributeur de Corniche Street — est-ce exact ?",
    "C'est exact. Ce n'est pas moi — arrêtez cela, je vous en prie !",
    "Je l'arrête immédiatement. Je place un blocage temporaire sur votre carte se terminant par 9034 — le retrait sera refusé en cours d'opération. Il peut être levé instantanément dès réception de votre nouvelle carte.",
    "200 OK · 210ms — gel : temporaire · motif : retrait sur carte clonée · vérification : 2/3 + incohérence géographique",
    "C'est fait — le retrait a été refusé et votre carte est bloquée. Je vous passe ma collègue Sara, spécialiste anti-fraude, qui va sécuriser votre compte et émettre votre carte de remplacement. Merci de rester en ligne.",
    (m) =>
      `Transfert chaud vers une spécialiste humaine (Sara H.) — contexte complet transmis : statut de la vérification, événement de fraude confirmé, confirmation de l'action, indicateurs de sentiment. Dossier ${m.caseId} créé.`,
    "Journal d'audit scellé — enregistrement de l'appel, transcription intégrale, méthode de vérification et horodatage de l'action ajoutés au registre d'audit chaîné par hachage, que la base de données interdit de modifier.",
    (m) =>
      `RÉSOLU — du signal de fraude à une mesure de protection, staged dans la limite de cas de 60 secondes (simulation guidée, temps comprimé). Perte estimée évitée : ${m.preventedLoss.en}. Ancienne méthode : 38 minutes.`,
  ],

  /* ————————— IMPERSONATION WIRE SCAM ————————— */
  wire: [
    "SIGNAL DE FRAUDE REÇU — virement sortant de 48,000.00 dirhams vers le nouveau bénéficiaire M. TRADING LLC, en attente d'autorisation. Score de risque 0.99 (critique). Bénéficiaire signalé comme compte relais connu ; pattern d'ingénierie sociale sur les appels récents.",
    "Alerte validée et enrichie. File d'attente en priorité P1 — SLA de contact client : 60 secondes.",
    "Appel sortant passé au numéro enregistré +971 •• ••• 2210 (Khalid Al-Mansoori). Canal préchauffé, profil vocal français (FR-FR). Le client est déjà sur une autre ligne — appel d'un escroc présumé.",
    "Appel connecté en 1.0 s, interruption par alerte d'appel en cours. Enregistrement activé. L'assistant est verrouillé sur le français dès la première réponse détectée.",
    (m) =>
      `Bonjour, je suis l'assistant de sécurité IA de votre banque ; j'appelle au sujet d'une activité récente sur votre compte. Cet appel est enregistré pour protéger votre compte. Est-ce bien ${m.customer} qui me parle ?`,
    (m, first) => `Oui, c'est bien ${first}.`,
    "Merci Khalid. Pour vérifier votre identité, dites-moi lesquelles de ces activités récentes vous reconnaissez : première — 210.00 dirhams chez Talabat, le 15 septembre. deuxième — votre loyer de 5,500.00 dirhams, le 1er septembre. troisième — un nouveau bénéficiaire, M. TRADING LLC, pour 48,000.00 dirhams, en attente de votre validation à cet instant.",
    "Les deux premières sont bien de moi. Pour le virement — un homme de l'équipe sécurité de ma banque m'a dit de transférer mon épargne vers un compte sécurisé. Ce n'était pas vous ?",
    "Vérification réussie — 2 éléments sur 3 reconnus. Arnaque à l'usurpation d'identité en direct confirmée : « l'équipe sécurité de la banque » n'est pas la banque. Aucun code PIN ni mot de passe demandé à aucun moment.",
    "Khalid, écoutez-moi bien : cet appel ne venait pas de votre banque. Votre banque ne vous demandera JAMAIS de transférer de l'argent vers un compte sécurisé. Confirmons : vous n'avez PAS autorisé le virement de 48,000.00 dirhams vers M. TRADING LLC — est-ce exact ?",
    "C'est exact. Je ne l'ai jamais autorisé. Dieu merci, vous avez appelé.",
    "Pour vous protéger, je place une suspension immédiate sur le virement de 48,000.00 dirhams — l'argent ne quitte pas votre compte. Je bloque aussi le nouveau bénéficiaire. Les deux actions sont entièrement journalisées et notre équipe anti-fraude peut les annuler.",
    "200 OK · 260ms — suspension : virement · motif : ingénierie sociale · bénéficiaire : bloqué · vérification : 2/3",
    "C'est fait — le virement est suspendu et votre argent est en sécurité. Je vous passe ma collègue Sara, spécialiste anti-fraude, qui va sécuriser votre compte et déposer le signalement. Merci de rester en ligne.",
    (m) =>
      `Transfert chaud vers une spécialiste humaine (Sara H.) — contexte complet transmis : statut de la vérification, événement de fraude confirmé, confirmation de l'action, indicateurs de sentiment. Dossier ${m.caseId} créé.`,
    "Journal d'audit scellé — enregistrement de l'appel, transcription intégrale, méthode de vérification et horodatage de l'action ajoutés au registre d'audit chaîné par hachage, que la base de données interdit de modifier.",
    (m) =>
      `RÉSOLU — du signal de fraude à une mesure de protection, staged dans la limite de cas de 60 secondes (simulation guidée, temps comprimé). Perte estimée évitée : ${m.preventedLoss.en}. Ancienne méthode : 38 minutes.`,
  ],

  /* ————————— INSURANCE · CLAIM PAYOUT REDIRECT ————————— */
  claim: [
    // e01 · alert
    "SIGNAL DE FRAUDE REÇU — indemnité du sinistre CLM-70412 de 62,000.00 dirhams réorientée vers un compte bancaire ajouté au profil du souscripteur il y a 4 minutes, après une connexion depuis un nouvel appareil. Score de risque 0.96 (critique). Décaissement prévu dans 15 minutes.",
    // e02 · queue
    "Alerte validée et enrichie. File d'attente en priorité P1 — SLA de contact client : 60 secondes.",
    // e03 · dial
    "Appel sortant passé au numéro enregistré +971 •• ••• 3390 (Fatima Al-Zaabi). Canal préchauffé, profil vocal français (FR-FR). Le paiement du sinistre est encore en attente — pas encore décaissé.",
    // e04 · connected
    "Appel connecté en 1.1 s. Enregistrement activé. L'assistant est verrouillé sur le français dès la première réponse détectée.",
    // e05 · intro (insurer, not bank)
    (m) =>
      `Bonjour, je suis l'assistant de sécurité IA de votre assureur ; j'appelle au sujet d'une activité récente sur votre contrat. Cet appel est enregistré pour protéger votre contrat. Est-ce bien ${m.customer} qui me parle ?`,
    // e06 · identity
    (m, first) => `Oui, c'est bien ${first}.`,
    // e07 · verify
    "Merci Fatima. Pour vérifier votre identité, dites-moi lesquelles de ces dernières opérations vous reconnaissez : première — la prime de renouvellement de votre contrat auto, 1,840.00 dirhams, le 30 août. deuxième — le sinistre que vous avez déclaré le 9 septembre pour un dommage au pare-chocs arrière. troisième — une demande de décaissement du 17 septembre vers un compte bancaire ajouté à votre profil il y a seulement quatre minutes.",
    // e08 · verifyAns
    "Les deux premières sont bien de moi. Je n'ai ajouté aucun nouveau compte bancaire, et je n'ai pas encore demandé de décaissement — j'attends toujours le rapport du garage.",
    // e09 · verifyOk
    "Vérification réussie — 2 éléments sur 3 reconnus, challenge relevé sans aide. La connexion depuis le nouvel appareil n'a pas été reconnue par la cliente. Aucun code PIN, mot de passe ou numéro de contrat demandé à aucun moment.",
    // e10 · confirm
    "Je comprends, Fatima. Confirmons-le clairement : vous n'avez PAS demandé le décaissement de 62,000.00 dirhams du sinistre CLM-70412 vers le nouveau compte bancaire — est-ce exact ?",
    // e11 · confirmAns
    "C'est exact. Ce n'était pas moi.",
    // e12 · protect
    "Pour vous protéger, je signale ce décaissement pour suspension et je restreins les modifications de vos coordonnées de paiement, le temps qu'un spécialiste humain de la sécurité des sinistres l'examine. Rien n'est définitif tant que le spécialiste ne confirme pas, et votre sinistre n'est pas affecté.",
    // e13 · api
    "200 OK · 250ms — suspension du décaissement : en attente · motif : soupçon de fraude sur changement de bénéficiaire · non définitif · vérification : 2/3 réussie",
    // e14 · done
    "C'est fait — le décaissement est signalé pour suspension et votre sinistre est protégé. Je vous passe ma collègue Sara, spécialiste de la sécurité des sinistres, qui va confirmer la suspension et sécuriser votre compte. Merci de rester en ligne.",
    // e15 · handoff
    (m) =>
      `Transfert chaud vers une spécialiste humaine (Sara H.) — contexte complet transmis : statut de la vérification, événement de fraude confirmé, confirmation de l'action, indicateurs de sentiment. Dossier ${m.caseId} créé.`,
    // e16 · audit
    "Journal d'audit scellé — enregistrement de l'appel, transcription intégrale, méthode de vérification et horodatage de l'action ajoutés au registre d'audit chaîné par hachage, que la base de données interdit de modifier.",
    // e17 · outcome
    (m) =>
      `RÉSOLU — du signal de fraude à une mesure de protection, staged dans la limite de cas de 60 secondes (simulation guidée, temps comprimé). Perte estimée évitée : ${m.preventedLoss.en}. Ancienne méthode : 38 minutes.`,
  ],

  /* ————————— FAILURE / ESCALATION · VOICEMAIL → SMS FALLBACK ————————— */
  voicemail: [
    // e01 · alert
    (m) =>
      `SIGNAL DE FRAUDE REÇU — carte •• 2087, 3,900.00 dirhams chez Gold Souk Online, Dubaï. Score de risque 0.95 (critique). Dossier ${m.caseId}.`,
    // e02 · queue
    "Alerte validée et enrichie. File d'attente en priorité P1 — SLA de contact client : 60 secondes.",
    // e03 · dial
    (m) =>
      `Appel sortant passé au numéro enregistré ${m.phone} (Omar Siddiqui). Canal préchauffé, profil vocal français (FR-FR).`,
    // e04 · answering machine
    "Appel connecté en 1.4 s — répondeur détecté (message d'accueil + bip). Détection de répondeur déclenchée : l'assistant n'engage pas de conversation avec une boîte vocale.",
    // e05 · generic voicemail message (no amount, merchant or case number)
    "Bonjour, je suis l'assistant de sécurité automatisé par IA de votre banque. Nous avons essayé de vous joindre au sujet d'une activité récente sur votre carte. Veuillez appeler votre banque au numéro figurant au dos de votre carte. Nous ne vous demanderons jamais votre code PIN ni un code à usage unique. Au revoir.",
    // e06 · voicemail_detection fired
    "Outil voicemail_detection déclenché — appel terminé sans conversation. État du dossier : DIALING → VOICEMAIL → UNREACHABLE. Fenêtre de réponse SMS de 24 heures ouverte.",
    // e07 · blind-ping SMS
    (m) =>
      `SMS envoyé à l'aveugle au ${m.phone} : « Votre banque : nous avons essayé de vous joindre au sujet d'une activité récente sur votre carte se terminant par 2087. Répondez YES si c'est vous, ou NO si ce n'est pas vous. N'envoyez rien d'autre. »`,
    // e08 · why so little
    "Pourquoi si peu d'informations dans le SMS : les messages texte ne sont pas chiffrés, s'affichent sur l'écran de verrouillage et restent dans les journaux de l'opérateur — ils ne nomment ni le marchand ni le montant, seulement les quatre derniers chiffres.",
    // e09 · customer replies NO
    "NO",
    // e10 · parser
    "SMS entrant analysé : le message entier est lu exactement comme NO — pas de correspondance partielle. Le numéro expéditeur correspond à UN SEUL alerte ouvert (une seule institution), dans la fenêtre de réponse de 24 heures.",
    // e11 · reply sent
    "Réponse envoyée au client : « Merci. Nous avons signalé une fraude possible ; un spécialiste l'examinera et vous contactera. » Rien n'est promis sur l'état de la carte.",
    // e12 · api
    "200 OK · 180ms — statut : NOTIFIED · resolution_method: sms_reply_no · customer_response: no · handoff_queued: true · freeze_staged: false (rien n'est bloqué automatiquement — un humain décide)",
    // e13 · review ticket
    (m) =>
      `Ticket de revue anti-fraude humaine créé et attribué à la spécialiste Sara H. — référence SV-F-20417, dossier ${m.caseId}. File : revue anti-fraude · P1.`,
    // e14 · evidence, not authorisation
    "Note : une réponse SMS prouve la possession du téléphone, pas l'identité. Elle est enregistrée comme preuve pour l'équipe anti-fraude — pas comme autorisation d'agir.",
    // e15 · operator console
    (m) =>
      `Alerte envoyée à la console opérateur — dossier ${m.caseId} · P1 · le client a répondu NO par SMS, en attente d'une revue humaine.`,
    // e16 · audit
    "Journal d'audit scellé — tentative d'appel, détection du répondeur, SMS envoyé, réponse du client, décision de l'analyseur et ticket de revue humaine ajoutés au registre d'audit chaîné par hachage, que la base de données interdit de modifier.",
    // e17 · outcome
    (m) =>
      `ESCALADÉ — l'appel vocal a échoué ; le client a été joint par SMS de repli et transmis à une revue anti-fraude humaine en 66 secondes (temps de démo, compressé). Rien n'a été bloqué sans un humain. Montant examiné : ${m.preventedLoss.en}.`,
  ],
};
