import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import type { ToolContext } from "./_types.js";
import { jsonResult } from "./_helpers.js";

// versely_list_voices exposes every voice catalog the backend knows about so
// the LLM never has to ask the user for an ElevenLabs / Cartesia / Inworld /
// Minimax voice ID. Three classes of provider:
//
//   • Library providers (elevenlabs, cartesia, inworld) — hit the backend
//     endpoints that proxy the upstream voice library. Backend caches
//     responses in Redis for 24h, we cache once more per MCP process to
//     keep `query`-style filtering cheap.
//   • User-owned providers (cartesia-mine, inworld-mine, elevenlabs-saved)
//     — per-user, so we fetch fresh on each call.
//   • Static providers (minimax, gemini, suno, qwen, grok, chatterbox) — the
//     upstream APIs don't expose discoverable voice IDs, so the catalog is
//     mirrored here from content-creation-frontend/app/(main)/ai-speech.tsx.
//     Keep in sync if voices change upstream.

type VoiceProvider =
  | "elevenlabs"
  | "elevenlabs-library"
  | "elevenlabs-saved"
  | "cartesia"
  | "cartesia-mine"
  | "inworld"
  | "inworld-mine"
  | "minimax"
  | "gemini"
  | "suno"
  | "qwen"
  | "grok"
  | "chatterbox";

interface NormalizedVoice {
  id: string;
  name: string;
  gender?: string;
  language?: string;
  accent?: string;
  description?: string;
  preview_url?: string;
  tags?: string[];
  /** Additional provider-specific fields surfaced as-is. */
  [key: string]: unknown;
}

interface ProviderMeta {
  /** Which body field the audio generation tool expects voices on. */
  voiceField: "voice" | "voice_id";
  /** Canonical model names this provider serves (helps the LLM pick the right one). */
  models: string[];
  /** Human-readable description shown alongside results. */
  blurb: string;
}

const PROVIDER_META: Record<VoiceProvider, ProviderMeta> = {
  elevenlabs: {
    // KIE's elevenlabs proxy only accepts a curated 20-voice set, BY NAME
    // (not voice_id). Passing any other voice_id from the full ElevenLabs
    // library returns `code: 500, msg: "This voice is not within the range
    // of allowed options"`. So `id` here is the voice NAME — that's what
    // you pass as `voice` to versely_generate_audio.
    voiceField: "voice",
    models: ["Eleven Labs Speech Turbo", "Eleven Labs Multilingual"],
    blurb: "The 20 voices KIE actually accepts for Eleven Labs Speech Turbo / Multilingual. Pass `id` (which is the voice's name) as the `voice` field — these are the ONLY voices that work for ElevenLabs TTS via Versely.",
  },
  "elevenlabs-library": {
    // The full ElevenLabs shared library (~5000 voices). Discovery only —
    // KIE rejects every one of these voice_ids. Use this provider to browse
    // available voices and play preview URLs, but always pick from the
    // `elevenlabs` provider when actually generating.
    voiceField: "voice",
    models: ["(discovery only — not callable via versely_generate_audio; use the `elevenlabs` provider instead)"],
    blurb: "Full ElevenLabs shared library (~5000 voices). DISCOVERY/PREVIEW ONLY — KIE rejects every voice_id from this library. For TTS use the `elevenlabs` provider (curated 20-voice set).",
  },
  "elevenlabs-saved": {
    voiceField: "voice",
    models: ["(discovery only — voice samples cached in the user bucket)"],
    blurb: "Voices the current user has previewed/sampled into their bucket. Discovery only — these are cached preview files, not voice IDs callable via versely_generate_audio.",
  },
  cartesia: {
    voiceField: "voice_id",
    models: ["Cartesia (direct endpoint — not yet wired into versely_generate_audio)"],
    blurb: "Cartesia public voice library. Discovery only — Cartesia TTS is not currently routed through versely_generate_audio.",
  },
  "cartesia-mine": {
    voiceField: "voice_id",
    models: ["Cartesia (direct endpoint — not yet wired into versely_generate_audio)"],
    blurb: "Cartesia voices the current user has cloned. Discovery only.",
  },
  inworld: {
    voiceField: "voice_id",
    models: ["Inworld TTS (direct endpoint — not yet wired into versely_generate_audio)"],
    blurb: "Inworld voice library. Discovery only — Inworld TTS is not currently routed through versely_generate_audio.",
  },
  "inworld-mine": {
    voiceField: "voice_id",
    models: ["Inworld TTS (direct endpoint — not yet wired into versely_generate_audio)"],
    blurb: "Inworld voices the current user has cloned. Discovery only.",
  },
  minimax: {
    voiceField: "voice_id",
    models: ["Minimax Speech"],
    blurb: "Minimax Speech voices (universal + per-language).",
  },
  gemini: {
    voiceField: "voice",
    // Only "Gemini 3.1 Flash TTS" exists in the dispatcher's audio roster. The
    // old names ("Gemini Flash TTS" / "Flash Lite" / "Pro TTS") are catalog-only
    // labels — passing them to versely_generate_audio 400s "Model not supported".
    models: ["Gemini 3.1 Flash TTS"],
    blurb: "Gemini TTS prebuilt voices (30 voices). Callable via versely_generate_audio with model 'Gemini 3.1 Flash TTS'.",
  },
  suno: {
    voiceField: "voice",
    // Suno has no TTS voice concept in this backend — "Suno Sounds V5/V5.5" are
    // absent from every provider's audio roster, and the six SUNO_VOICES below
    // exist nowhere server-side. Discovery only; do not hand these to the LLM
    // as callable TTS models.
    models: [
      "(discovery only — Suno has no TTS voices; use versely_generate_music for music, or another provider for speech)",
    ],
    blurb: "Legacy Suno voice labels. NOT callable via versely_generate_audio — no Suno TTS model exists.",
  },
  qwen: {
    voiceField: "voice",
    models: ["Qwen 3 TTS 1.7B", "Qwen 3 TTS 0.6B"],
    blurb: "Qwen 3 TTS voices.",
  },
  grok: {
    voiceField: "voice",
    models: ["Grok TTS"],
    blurb: "Grok (xAI) TTS voices.",
  },
  chatterbox: {
    voiceField: "voice",
    models: ["Chatterbox TTS", "Chatterbox TTS Turbo"],
    blurb: "Chatterbox built-in TTS voices (served via fal).",
  },
};

// --- Static catalogs (mirrored from content-creation-frontend/app/(main)/ai-speech.tsx) ---

// KIE's elevenlabs proxy accepts only the 20 default ElevenLabs voices, by
// NAME (not voice_id). Verified by probing
// https://api.kie.ai/api/v1/jobs/createTask against text-to-speech-turbo-2-5
// — every other voice id / name returns "This voice is not within the range
// of allowed options". `id` here is the voice name because that's what the
// LLM must pass through as the `voice` body field.
const ELEVENLABS_KIE_VOICES: NormalizedVoice[] = [
  { id: "Aria", name: "Aria", gender: "female", accent: "american", description: "American female, expressive, social media" },
  { id: "Roger", name: "Roger", gender: "male", accent: "american", description: "American male, confident, narration" },
  { id: "Sarah", name: "Sarah", gender: "female", accent: "american", description: "American female, soft, news" },
  { id: "Laura", name: "Laura", gender: "female", accent: "american", description: "American female, upbeat, social media" },
  { id: "Charlie", name: "Charlie", gender: "male", accent: "australian", description: "Australian male, casual, conversational" },
  { id: "George", name: "George", gender: "male", accent: "british", description: "British male, warm, narration" },
  { id: "Callum", name: "Callum", gender: "male", accent: "transatlantic", description: "Transatlantic male, intense, characters" },
  { id: "River", name: "River", gender: "neutral", accent: "american", description: "American neutral, conversational, social media" },
  { id: "Liam", name: "Liam", gender: "male", accent: "american", description: "American male, articulate, narration" },
  { id: "Charlotte", name: "Charlotte", gender: "female", accent: "swedish", description: "Swedish female, seductive, characters" },
  { id: "Alice", name: "Alice", gender: "female", accent: "british", description: "British female, confident, news" },
  { id: "Matilda", name: "Matilda", gender: "female", accent: "american", description: "American female, friendly, narration" },
  { id: "Will", name: "Will", gender: "male", accent: "american", description: "American male, friendly, social media" },
  { id: "Jessica", name: "Jessica", gender: "female", accent: "american", description: "American female, expressive, conversational" },
  { id: "Eric", name: "Eric", gender: "male", accent: "american", description: "American male, classy, conversational" },
  { id: "Chris", name: "Chris", gender: "male", accent: "american", description: "American male, casual, conversational" },
  { id: "Brian", name: "Brian", gender: "male", accent: "american", description: "American male, deep, narration" },
  { id: "Daniel", name: "Daniel", gender: "male", accent: "british", description: "British male, authoritative, news" },
  { id: "Lily", name: "Lily", gender: "female", accent: "british", description: "British female, warm, narration" },
  { id: "Bill", name: "Bill", gender: "male", accent: "american", description: "American male, trustworthy, narration" },
];

const QWEN_VOICES: NormalizedVoice[] = [
  { id: "Vivian", name: "Vivian", gender: "female", description: "Female, expressive" },
  { id: "Serena", name: "Serena", gender: "female", description: "Female, calm" },
  { id: "Uncle_Fu", name: "Uncle Fu", gender: "male", description: "Male, mature" },
  { id: "Dylan", name: "Dylan", gender: "male", description: "Male, friendly" },
  { id: "Eric", name: "Eric", gender: "male", description: "Male, neutral" },
  { id: "Ryan", name: "Ryan", gender: "male", description: "Male, energetic" },
  { id: "Aiden", name: "Aiden", gender: "male", description: "Male, casual" },
  { id: "Ono_Anna", name: "Ono Anna", gender: "female", language: "Japanese", description: "Female, Japanese" },
  { id: "Sohee", name: "Sohee", gender: "female", language: "Korean", description: "Female, Korean" },
];

const GROK_VOICES: NormalizedVoice[] = [
  { id: "eve", name: "Eve", description: "Energetic, upbeat" },
  { id: "ara", name: "Ara", description: "Warm, friendly" },
  { id: "rex", name: "Rex", description: "Confident, clear" },
  { id: "sal", name: "Sal", description: "Smooth, balanced" },
  { id: "leo", name: "Leo", description: "Authoritative, strong" },
];

const SUNO_VOICES: NormalizedVoice[] = [
  { id: "aurora", name: "Aurora", gender: "female", description: "Warm, expressive female voice" },
  { id: "blaze", name: "Blaze", gender: "male", description: "Energetic, dynamic male voice" },
  { id: "celeste", name: "Celeste", gender: "female", description: "Soft, soothing female voice" },
  { id: "drift", name: "Drift", gender: "male", description: "Calm, narrative male voice" },
  { id: "ember", name: "Ember", gender: "female", description: "Bold, confident female voice" },
  { id: "frost", name: "Frost", gender: "male", description: "Clear, articulate male voice" },
];

const CHATTERBOX_VOICES: NormalizedVoice[] = [
  "Aaron", "Abigail", "Anaya", "Andy", "Archer", "Brian", "Chloe", "Dylan",
  "Emmanuel", "Ethan", "Evelyn", "Gavin", "Gordon", "Ivan", "Laura", "Lucy",
  "Madison", "Marisol", "Meera", "Walter",
].map((n) => ({ id: n, name: n }));

const GEMINI_VOICES: NormalizedVoice[] = [
  { id: "Achernar", name: "Achernar", gender: "female" }, { id: "Achird", name: "Achird", gender: "male" },
  { id: "Algenib", name: "Algenib", gender: "male" }, { id: "Algieba", name: "Algieba", gender: "male" },
  { id: "Alnilam", name: "Alnilam", gender: "male" }, { id: "Aoede", name: "Aoede", gender: "female" },
  { id: "Autonoe", name: "Autonoe", gender: "female" }, { id: "Callirrhoe", name: "Callirrhoe", gender: "female" },
  { id: "Charon", name: "Charon", gender: "male" }, { id: "Despina", name: "Despina", gender: "female" },
  { id: "Enceladus", name: "Enceladus", gender: "male" }, { id: "Erinome", name: "Erinome", gender: "female" },
  { id: "Fenrir", name: "Fenrir", gender: "male" }, { id: "Gacrux", name: "Gacrux", gender: "female" },
  { id: "Iapetus", name: "Iapetus", gender: "male" }, { id: "Kore", name: "Kore", gender: "female" },
  { id: "Laomedeia", name: "Laomedeia", gender: "female" }, { id: "Leda", name: "Leda", gender: "female" },
  { id: "Orus", name: "Orus", gender: "male" }, { id: "Pulcherrima", name: "Pulcherrima", gender: "female" },
  { id: "Puck", name: "Puck", gender: "male" }, { id: "Rasalgethi", name: "Rasalgethi", gender: "male" },
  { id: "Sadachbia", name: "Sadachbia", gender: "male" }, { id: "Sadaltager", name: "Sadaltager", gender: "male" },
  { id: "Schedar", name: "Schedar", gender: "male" }, { id: "Sulafat", name: "Sulafat", gender: "female" },
  { id: "Umbriel", name: "Umbriel", gender: "male" }, { id: "Vindemiatrix", name: "Vindemiatrix", gender: "female" },
  { id: "Zephyr", name: "Zephyr", gender: "female" }, { id: "Zubenelgenubi", name: "Zubenelgenubi", gender: "male" },
];

const MINIMAX_VOICES: NormalizedVoice[] = (() => {
  const entries: { id: string; name: string; language: string }[] = [
    { id: "Wise_Woman", name: "Wise Woman", language: "Universal" },
    { id: "Friendly_Person", name: "Friendly Person", language: "Universal" },
    { id: "Inspirational_girl", name: "Inspirational Girl", language: "Universal" },
    { id: "Deep_Voice_Man", name: "Deep Voice Man", language: "Universal" },
    { id: "Calm_Woman", name: "Calm Woman", language: "Universal" },
    { id: "Casual_Guy", name: "Casual Guy", language: "Universal" },
    { id: "Lively_Girl", name: "Lively Girl", language: "Universal" },
    { id: "Patient_Man", name: "Patient Man", language: "Universal" },
    { id: "Young_Knight", name: "Young Knight", language: "Universal" },
    { id: "Determined_Man", name: "Determined Man", language: "Universal" },
    { id: "Lovely_Girl", name: "Lovely Girl", language: "Universal" },
    { id: "Decent_Boy", name: "Decent Boy", language: "Universal" },
    { id: "Imposing_Manner", name: "Imposing Manner", language: "Universal" },
    { id: "Elegant_Man", name: "Elegant Man", language: "Universal" },
    { id: "Abbess", name: "Abbess", language: "Universal" },
    { id: "Sweet_Girl_2", name: "Sweet Girl 2", language: "Universal" },
    { id: "Exuberant_Girl", name: "Exuberant Girl", language: "Universal" },
    { id: "English_expressive_narrator", name: "Expressive Narrator", language: "English" },
    { id: "English_radiant_girl", name: "Radiant Girl", language: "English" },
    { id: "English_magnetic_voiced_man", name: "Magnetic Voiced Man", language: "English" },
    { id: "English_compelling_lady1", name: "Compelling Lady", language: "English" },
    { id: "English_Aussie_Bloke", name: "Aussie Bloke", language: "English" },
    { id: "English_captivating_female1", name: "Captivating Female", language: "English" },
    { id: "English_Upbeat_Woman", name: "Upbeat Woman", language: "English" },
    { id: "English_Trustworth_Man", name: "Trustworthy Man", language: "English" },
    { id: "English_CalmWoman", name: "Calm Woman", language: "English" },
    { id: "English_UpsetGirl", name: "Upset Girl", language: "English" },
    { id: "English_Gentle-voiced_man", name: "Gentle-Voiced Man", language: "English" },
    { id: "English_Whispering_girl_v3", name: "Whispering Girl", language: "English" },
    { id: "English_Diligent_Man", name: "Diligent Man", language: "English" },
    { id: "English_Graceful_Lady", name: "Graceful Lady", language: "English" },
    { id: "English_Husky_MetalHead", name: "Husky MetalHead", language: "English" },
    { id: "English_ReservedYoungMan", name: "Reserved Young Man", language: "English" },
    { id: "English_PlayfulGirl", name: "Playful Girl", language: "English" },
    { id: "English_ManWithDeepVoice", name: "Man With Deep Voice", language: "English" },
    { id: "English_GentleTeacher", name: "Gentle Teacher", language: "English" },
    { id: "English_MaturePartner", name: "Mature Partner", language: "English" },
    { id: "English_FriendlyPerson", name: "Friendly Person", language: "English" },
    { id: "English_MatureBoss", name: "Mature Boss", language: "English" },
    { id: "English_Debator", name: "Debator", language: "English" },
    { id: "English_Abbess", name: "Abbess", language: "English" },
    { id: "English_LovelyGirl", name: "Lovely Girl", language: "English" },
    { id: "English_Steadymentor", name: "Steady Mentor", language: "English" },
    { id: "English_Deep-VoicedGentleman", name: "Deep-Voiced Gentleman", language: "English" },
    { id: "English_DeterminedMan", name: "Determined Man", language: "English" },
    { id: "English_Wiselady", name: "Wise Lady", language: "English" },
    { id: "English_CaptivatingStoryteller", name: "Captivating Storyteller", language: "English" },
    { id: "English_AttractiveGirl", name: "Attractive Girl", language: "English" },
    { id: "English_DecentYoungMan", name: "Decent Young Man", language: "English" },
    { id: "English_SentimentalLady", name: "Sentimental Lady", language: "English" },
    { id: "English_ImposingManner", name: "Imposing Manner", language: "English" },
    { id: "English_SadTeen", name: "Sad Teen", language: "English" },
    { id: "English_ThoughtfulMan", name: "Thoughtful Man", language: "English" },
    { id: "English_PassionateWarrior", name: "Passionate Warrior", language: "English" },
    { id: "English_DecentBoy", name: "Decent Boy", language: "English" },
    { id: "English_WiseScholar", name: "Wise Scholar", language: "English" },
    { id: "English_Soft-spokenGirl", name: "Soft-Spoken Girl", language: "English" },
    { id: "English_SereneWoman", name: "Serene Woman", language: "English" },
    { id: "English_ConfidentWoman", name: "Confident Woman", language: "English" },
    { id: "English_PatientMan", name: "Patient Man", language: "English" },
    { id: "English_Comedian", name: "Comedian", language: "English" },
    { id: "English_GorgeousLady", name: "Gorgeous Lady", language: "English" },
    { id: "English_BossyLeader", name: "Bossy Leader", language: "English" },
    { id: "English_LovelyLady", name: "Lovely Lady", language: "English" },
    { id: "English_Strong-WilledBoy", name: "Strong-Willed Boy", language: "English" },
    { id: "English_Deep-tonedMan", name: "Deep-Toned Man", language: "English" },
    { id: "English_StressedLady", name: "Stressed Lady", language: "English" },
    { id: "English_AssertiveQueen", name: "Assertive Queen", language: "English" },
    { id: "English_AnimeCharacter", name: "Anime Character", language: "English" },
    { id: "English_Jovialman", name: "Jovial Man", language: "English" },
    { id: "English_WhimsicalGirl", name: "Whimsical Girl", language: "English" },
    { id: "English_CharmingQueen", name: "Charming Queen", language: "English" },
    { id: "English_Kind-heartedGirl", name: "Kind-Hearted Girl", language: "English" },
    { id: "English_FriendlyNeighbor", name: "Friendly Neighbor", language: "English" },
    { id: "English_Sweet_Female_4", name: "Sweet Female", language: "English" },
    { id: "English_Magnetic_Male_2", name: "Magnetic Male", language: "English" },
    { id: "English_Lively_Male_11", name: "Lively Male", language: "English" },
    { id: "English_Friendly_Female_3", name: "Friendly Female", language: "English" },
    { id: "English_Steady_Female_1", name: "Steady Female", language: "English" },
    { id: "English_Insightful_Speaker", name: "Insightful Speaker", language: "English" },
    { id: "English_patient_man_v1", name: "Patient Man v1", language: "English" },
    { id: "English_Persuasive_Man", name: "Persuasive Man", language: "English" },
    { id: "English_Explanatory_Man", name: "Explanatory Man", language: "English" },
    { id: "English_intellect_female_1", name: "Intellectual Female", language: "English" },
    { id: "English_energetic_male_1", name: "Energetic Male", language: "English" },
    { id: "English_witty_female_1", name: "Witty Female", language: "English" },
    { id: "English_Lucky_Robot", name: "Lucky Robot", language: "English" },
    { id: "English_Cute_Girl", name: "Cute Girl", language: "English" },
    { id: "English_Sharp_Commentator", name: "Sharp Commentator", language: "English" },
    { id: "English_Honest_Man", name: "Honest Man", language: "English" },
    { id: "whisper_man", name: "Whisper Man", language: "English" },
    { id: "whisper_woman_1", name: "Whisper Woman", language: "English" },
    { id: "conversational_female_1_v1", name: "Conversational Female 1", language: "English" },
    { id: "conversational_female_2_v1", name: "Conversational Female 2", language: "English" },
    { id: "socialmedia_female_1_v1", name: "Social Media Female", language: "English" },
    { id: "BritishChild_male_1_v1", name: "British Child (Male)", language: "English" },
    { id: "BritishChild_female_1_v1", name: "British Child (Female)", language: "English" },
    { id: "angry_pirate_1", name: "Angry Pirate", language: "Character" },
    { id: "massive_kind_troll", name: "Kind Troll", language: "Character" },
    { id: "movie_trailer_deep", name: "Movie Trailer", language: "Character" },
    { id: "peace_and_ease", name: "Peace & Ease", language: "Character" },
    { id: "Spanish_FriendlyNeighbor", name: "Friendly Neighbor", language: "Spanish" },
    { id: "Spanish_SereneWoman", name: "Serene Woman", language: "Spanish" },
    { id: "Spanish_CaptivatingStoryteller", name: "Captivating Storyteller", language: "Spanish" },
    { id: "Spanish_Narrator", name: "Narrator", language: "Spanish" },
    { id: "Spanish_WiseScholar", name: "Wise Scholar", language: "Spanish" },
    { id: "Spanish_ConfidentWoman", name: "Confident Woman", language: "Spanish" },
    { id: "Spanish_ThoughtfulMan", name: "Thoughtful Man", language: "Spanish" },
    { id: "Spanish_BossyLeader", name: "Bossy Leader", language: "Spanish" },
    { id: "Spanish_Comedian", name: "Comedian", language: "Spanish" },
    { id: "Spanish_Debator", name: "Debator", language: "Spanish" },
    { id: "Spanish_Wiselady", name: "Wise Lady", language: "Spanish" },
    { id: "Spanish_Steadymentor", name: "Steady Mentor", language: "Spanish" },
    { id: "Spanish_Jovialman", name: "Jovial Man", language: "Spanish" },
    { id: "Spanish_AnimeCharacter", name: "Anime Character", language: "Spanish" },
    { id: "Spanish_CharmingQueen", name: "Charming Queen", language: "Spanish" },
    { id: "Spanish_Kind-heartedGirl", name: "Kind-Hearted Girl", language: "Spanish" },
    { id: "Spanish_PassionateWarrior", name: "Passionate Warrior", language: "Spanish" },
    { id: "Spanish_AssertiveQueen", name: "Assertive Queen", language: "Spanish" },
    { id: "Spanish_WhimsicalGirl", name: "Whimsical Girl", language: "Spanish" },
    { id: "Spanish_Deep-tonedMan", name: "Deep-Toned Man", language: "Spanish" },
    { id: "French_Male_Speech_New", name: "Male Speech", language: "French" },
    { id: "French_Female_Speech_New", name: "Female Speech", language: "French" },
    { id: "French_CasualMan", name: "Casual Man", language: "French" },
    { id: "French_MovieLeadFemale", name: "Movie Lead Female", language: "French" },
    { id: "French_FemaleAnchor", name: "Female Anchor", language: "French" },
    { id: "French_MaleNarrator", name: "Male Narrator", language: "French" },
    { id: "German_FriendlyMan", name: "Friendly Man", language: "German" },
    { id: "German_SweetLady", name: "Sweet Lady", language: "German" },
    { id: "German_PlayfulMan", name: "Playful Man", language: "German" },
    { id: "Japanese_IntellectualSenior", name: "Intellectual Senior", language: "Japanese" },
    { id: "Japanese_DecisivePrincess", name: "Decisive Princess", language: "Japanese" },
    { id: "Japanese_LoyalKnight", name: "Loyal Knight", language: "Japanese" },
    { id: "Japanese_DominantMan", name: "Dominant Man", language: "Japanese" },
    { id: "Japanese_SeriousCommander", name: "Serious Commander", language: "Japanese" },
    { id: "Japanese_ColdQueen", name: "Cold Queen", language: "Japanese" },
    { id: "Japanese_DependableWoman", name: "Dependable Woman", language: "Japanese" },
    { id: "Japanese_GentleButler", name: "Gentle Butler", language: "Japanese" },
    { id: "Japanese_KindLady", name: "Kind Lady", language: "Japanese" },
    { id: "Japanese_CalmLady", name: "Calm Lady", language: "Japanese" },
    { id: "Japanese_OptimisticYouth", name: "Optimistic Youth", language: "Japanese" },
    { id: "Japanese_InnocentBoy", name: "Innocent Boy", language: "Japanese" },
    { id: "Japanese_GracefulMaiden", name: "Graceful Maiden", language: "Japanese" },
    { id: "Japanese_Whisper_Belle", name: "Whisper Belle", language: "Japanese" },
    { id: "Korean_PowerfulGirl", name: "Powerful Girl", language: "Korean" },
    { id: "Korean_SweetGirl", name: "Sweet Girl", language: "Korean" },
    { id: "Korean_CheerfulBoyfriend", name: "Cheerful Boyfriend", language: "Korean" },
    { id: "Korean_ElegantPrincess", name: "Elegant Princess", language: "Korean" },
    { id: "Korean_BraveFemaleWarrior", name: "Brave Female Warrior", language: "Korean" },
    { id: "Korean_CalmLady", name: "Calm Lady", language: "Korean" },
    { id: "Korean_IntellectualSenior", name: "Intellectual Senior", language: "Korean" },
    { id: "Korean_CalmGentleman", name: "Calm Gentleman", language: "Korean" },
    { id: "Korean_WiseElf", name: "Wise Elf", language: "Korean" },
    { id: "Korean_DecisiveQueen", name: "Decisive Queen", language: "Korean" },
    { id: "Korean_MysteriousGirl", name: "Mysterious Girl", language: "Korean" },
    { id: "Korean_WiseTeacher", name: "Wise Teacher", language: "Korean" },
    { id: "Korean_GentleWoman", name: "Gentle Woman", language: "Korean" },
    { id: "Korean_ConfidentBoss", name: "Confident Boss", language: "Korean" },
    { id: "Korean_OptimisticYouth", name: "Optimistic Youth", language: "Korean" },
    { id: "Portuguese_Narrator", name: "Narrator", language: "Portuguese" },
    { id: "Portuguese_SereneWoman", name: "Serene Woman", language: "Portuguese" },
    { id: "Portuguese_ConfidentWoman", name: "Confident Woman", language: "Portuguese" },
    { id: "Portuguese_CaptivatingStoryteller", name: "Captivating Storyteller", language: "Portuguese" },
    { id: "Portuguese_BossyLeader", name: "Bossy Leader", language: "Portuguese" },
    { id: "Portuguese_Comedian", name: "Comedian", language: "Portuguese" },
    { id: "Portuguese_ThoughtfulMan", name: "Thoughtful Man", language: "Portuguese" },
    { id: "Portuguese_GentleTeacher", name: "Gentle Teacher", language: "Portuguese" },
    { id: "Portuguese_ReliableMan", name: "Reliable Man", language: "Portuguese" },
    { id: "Portuguese_AssertiveQueen", name: "Assertive Queen", language: "Portuguese" },
    { id: "Portuguese_CharmingQueen", name: "Charming Queen", language: "Portuguese" },
    { id: "Portuguese_WhimsicalGirl", name: "Whimsical Girl", language: "Portuguese" },
    { id: "Italian_BraveHeroine", name: "Brave Heroine", language: "Italian" },
    { id: "Italian_Narrator", name: "Narrator", language: "Italian" },
    { id: "Italian_WanderingSorcerer", name: "Wandering Sorcerer", language: "Italian" },
    { id: "Italian_DiligentLeader", name: "Diligent Leader", language: "Italian" },
    { id: "Italian_ReliableMan", name: "Reliable Man", language: "Italian" },
    { id: "Italian_AthleticStudent", name: "Athletic Student", language: "Italian" },
    { id: "Italian_ArrogantPrincess", name: "Arrogant Princess", language: "Italian" },
    { id: "Russian_BrightHeroine", name: "Bright Heroine", language: "Russian" },
    { id: "Russian_AmbitiousWoman", name: "Ambitious Woman", language: "Russian" },
    { id: "Russian_ReliableMan", name: "Reliable Man", language: "Russian" },
    { id: "Russian_AttractiveGuy", name: "Attractive Guy", language: "Russian" },
    { id: "Indonesian_SweetGirl", name: "Sweet Girl", language: "Indonesian" },
    { id: "Indonesian_CalmWoman", name: "Calm Woman", language: "Indonesian" },
    { id: "Indonesian_ConfidentWoman", name: "Confident Woman", language: "Indonesian" },
    { id: "Indonesian_CaringMan", name: "Caring Man", language: "Indonesian" },
    { id: "Indonesian_BossyLeader", name: "Bossy Leader", language: "Indonesian" },
    { id: "Indonesian_GentleGirl", name: "Gentle Girl", language: "Indonesian" },
    { id: "Arabic_CalmWoman", name: "Calm Woman", language: "Arabic" },
    { id: "Arabic_FriendlyGuy", name: "Friendly Guy", language: "Arabic" },
    { id: "hindi_male_1_v2", name: "Male Voice", language: "Hindi" },
    { id: "hindi_female_2_v1", name: "Female Voice 1", language: "Hindi" },
    { id: "hindi_female_1_v2", name: "Female Voice 2", language: "Hindi" },
    { id: "Dutch_kindhearted_girl", name: "Kind-Hearted Girl", language: "Dutch" },
    { id: "Dutch_bossy_leader", name: "Bossy Leader", language: "Dutch" },
    { id: "Turkish_CalmWoman", name: "Calm Woman", language: "Turkish" },
    { id: "Turkish_Trustworthyman", name: "Trustworthy Man", language: "Turkish" },
    { id: "Thai_Optimistic_girl", name: "Optimistic Girl", language: "Thai" },
    { id: "Thai_Tender_Woman", name: "Tender Woman", language: "Thai" },
    { id: "Vietnamese_Serene_Man", name: "Serene Man", language: "Vietnamese" },
    { id: "Vietnamese_kindhearted_girl", name: "Kind-Hearted Girl", language: "Vietnamese" },
    { id: "Polish_male_1_sample4", name: "Male Voice", language: "Polish" },
    { id: "Polish_female_1_sample1", name: "Female Voice", language: "Polish" },
    { id: "Swedish_male_1_v1", name: "Male Voice", language: "Swedish" },
    { id: "Swedish_female_1_v1", name: "Female Voice", language: "Swedish" },
    { id: "Danish_male_1_v1", name: "Male Voice", language: "Danish" },
    { id: "Danish_female_1_v1", name: "Female Voice", language: "Danish" },
    { id: "Norwegian_male_1_v1", name: "Male Voice", language: "Norwegian" },
    { id: "Norwegian_female_1_v1", name: "Female Voice", language: "Norwegian" },
    { id: "finnish_male_3_v1", name: "Male Voice", language: "Finnish" },
    { id: "finnish_female_4_v1", name: "Female Voice", language: "Finnish" },
    { id: "Greek_female_1_sample1", name: "Female Voice", language: "Greek" },
    { id: "greek_male_1a_v1", name: "Male Voice", language: "Greek" },
    { id: "czech_male_1_v1", name: "Male Voice", language: "Czech" },
    { id: "czech_female_5_v7", name: "Female Voice", language: "Czech" },
    { id: "Romanian_male_1_sample2", name: "Male Voice", language: "Romanian" },
    { id: "Romanian_female_1_sample4", name: "Female Voice", language: "Romanian" },
    { id: "Hungarian_male_1_v1", name: "Male Voice", language: "Hungarian" },
    { id: "Hungarian_female_1_v1", name: "Female Voice", language: "Hungarian" },
    { id: "Ukrainian_CalmWoman", name: "Calm Woman", language: "Ukrainian" },
    { id: "Ukrainian_WiseScholar", name: "Wise Scholar", language: "Ukrainian" },
    { id: "Hebrew_male_1_v1", name: "Male Voice", language: "Hebrew" },
    { id: "Hebrew_female_1_v1", name: "Female Voice", language: "Hebrew" },
    { id: "Filipino_male_1_v1", name: "Male Voice", language: "Filipino" },
    { id: "Filipino_female_1_v1", name: "Female Voice", language: "Filipino" },
    { id: "Malay_male_1_v1", name: "Male Voice", language: "Malay" },
    { id: "Malay_female_1_v1", name: "Female Voice", language: "Malay" },
    { id: "Tamil_male_1_v1", name: "Male Voice", language: "Tamil" },
    { id: "Tamil_female_1_v1", name: "Female Voice", language: "Tamil" },
    { id: "Persian_male_1_v1", name: "Male Voice", language: "Persian" },
    { id: "Persian_female_1_v1", name: "Female Voice", language: "Persian" },
  ];
  // Infer gender from id pattern (`*_male_*`, `*Man*`, `Boy`, `Knight` → male,
  // similar for female) so the gender filter works without enumerating.
  const MALE_RX = /(_male_|_Man\b|_man\b|Boy\b|Knight\b|Bloke|Guy\b|Fellow|Gentleman|Mentor|Narrator|Warrior|Speaker|Teacher|Father|Brother|Leader|Pirate|Troll|Sorcerer|Heroine|Hero\b|Robot|Commentator|Commander|Butler|Senior|Boyfriend|Anchor|Scholar)/i;
  const FEMALE_RX = /(_female_|_Woman\b|_woman\b|Girl\b|Lady\b|Queen\b|Princess|Heroine|Maiden|Witch|Mother|Sister|Belle|Anna|Sohee|Vivian|Serena)/i;
  return entries.map((e) => {
    const m = MALE_RX.test(e.id) || MALE_RX.test(e.name);
    const f = FEMALE_RX.test(e.id) || FEMALE_RX.test(e.name);
    const gender = m && !f ? "male" : f && !m ? "female" : undefined;
    return { id: e.id, name: e.name, language: e.language, ...(gender ? { gender } : {}) };
  });
})();

const STATIC_CATALOGS: Partial<Record<VoiceProvider, NormalizedVoice[]>> = {
  elevenlabs: ELEVENLABS_KIE_VOICES,
  qwen: QWEN_VOICES,
  grok: GROK_VOICES,
  suno: SUNO_VOICES,
  chatterbox: CHATTERBOX_VOICES,
  gemini: GEMINI_VOICES,
  minimax: MINIMAX_VOICES,
};

// --- Backend-served catalogs (cached per-process so query/filter is cheap) ---

interface CachedCatalog {
  voices: NormalizedVoice[];
  facets: { languages?: string[]; genders?: string[]; accents?: string[]; tags?: string[] };
  fetchedAt: number;
}

const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogCache = new Map<string, CachedCatalog>();

function cacheKey(provider: VoiceProvider, userId?: string): string {
  return userId ? `${provider}:${userId}` : provider;
}

function readCache(key: string): CachedCatalog | null {
  const hit = catalogCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > CATALOG_TTL_MS) {
    catalogCache.delete(key);
    return null;
  }
  return hit;
}

async function fetchDynamicCatalog(
  ctx: ToolContext,
  provider: VoiceProvider,
): Promise<CachedCatalog> {
  switch (provider) {
    case "elevenlabs-library": {
      const data = await ctx.client.get<{
        voices: Array<Record<string, unknown>>;
        categories?: string[];
        genders?: string[];
        accents?: string[];
        languages?: string[];
        use_cases?: string[];
      }>("/api/v1/audio/elevenlabs-voices");
      const voices: NormalizedVoice[] = (data.voices ?? []).map((v) => ({
        id: String(v.voice_id ?? ""),
        name: String(v.name ?? "Unknown"),
        gender: typeof v.gender === "string" && v.gender ? v.gender : undefined,
        accent: typeof v.accent === "string" && v.accent ? v.accent : undefined,
        language: typeof v.language === "string" && v.language ? v.language : undefined,
        description: typeof v.description === "string" && v.description ? v.description : undefined,
        preview_url: typeof v.preview_url === "string" && v.preview_url ? v.preview_url : undefined,
        category: typeof v.category === "string" && v.category ? v.category : undefined,
        use_case: typeof v.use_case === "string" && v.use_case ? v.use_case : undefined,
        descriptive: typeof v.descriptive === "string" && v.descriptive ? v.descriptive : undefined,
      }));
      return {
        voices,
        facets: {
          languages: data.languages,
          genders: data.genders,
          accents: data.accents,
        },
        fetchedAt: Date.now(),
      };
    }
    case "elevenlabs-saved": {
      const data = await ctx.client.get<{
        voices: Array<{ name: string; url: string; size?: number; mimetype?: string }>;
        count?: number;
        // The API router is mounted at /api/v1 — this was the only call site in the
        // MCP missing the prefix, so it 404'd on every request.
      }>("/api/v1/bucket/eleven-labs-voices");
      const voices: NormalizedVoice[] = (data.voices ?? []).map((v) => ({
        // These are cached audio sample files — the file name typically
        // encodes a voice identifier the user has previously sampled.
        // We surface both the name and the preview URL so the LLM can
        // either re-use the identifier or play back the sample.
        id: v.name.replace(/\.[^.]+$/, ""),
        name: v.name,
        preview_url: v.url,
        size: v.size,
        mimetype: v.mimetype,
      }));
      return { voices, facets: {}, fetchedAt: Date.now() };
    }
    case "cartesia": {
      const data = await ctx.client.get<{
        voices: Array<Record<string, unknown>>;
        genders?: string[];
        languages?: string[];
      }>("/api/v1/audio/cartesia-library");
      const voices: NormalizedVoice[] = (data.voices ?? []).map((v) => ({
        id: String(v.id ?? ""),
        name: String(v.name ?? "Unknown"),
        gender: typeof v.gender === "string" && v.gender ? v.gender : undefined,
        language: typeof v.language === "string" && v.language ? v.language : undefined,
        description: typeof v.description === "string" && v.description ? v.description : undefined,
        preview_url: typeof v.preview_url === "string" && v.preview_url ? v.preview_url : undefined,
      }));
      return {
        voices,
        facets: { languages: data.languages, genders: data.genders },
        fetchedAt: Date.now(),
      };
    }
    case "cartesia-mine": {
      const data = await ctx.client.get<{ data?: Array<Record<string, unknown>> }>(
        "/api/v1/audio/my-clones",
      );
      const voices: NormalizedVoice[] = (data.data ?? []).map((v) => ({
        id: String(v.voice_id ?? v.id ?? ""),
        name: String(v.name ?? v.display_name ?? "Cloned voice"),
        language: typeof v.language === "string" && v.language ? v.language : undefined,
        description: typeof v.description === "string" && v.description ? v.description : undefined,
      }));
      return { voices, facets: {}, fetchedAt: Date.now() };
    }
    case "inworld": {
      const data = await ctx.client.get<{
        voices: Array<Record<string, unknown>>;
        tags?: string[];
        languages?: string[];
      }>("/api/v1/inworld/voice-library");
      const voices: NormalizedVoice[] = (data.voices ?? []).map((v) => {
        const tags = Array.isArray(v.tags) ? (v.tags as string[]) : undefined;
        const langs = Array.isArray(v.languages) ? (v.languages as string[]) : undefined;
        return {
          id: String(v.voiceId ?? v.id ?? ""),
          name: String(v.displayName ?? v.name ?? v.voiceId ?? "Unknown"),
          gender: typeof v.gender === "string" && v.gender ? v.gender : undefined,
          language: langs && langs[0] ? langs[0] : undefined,
          languages: langs,
          tags,
          description: typeof v.description === "string" && v.description ? v.description : undefined,
        };
      });
      return {
        voices,
        facets: { languages: data.languages, tags: data.tags },
        fetchedAt: Date.now(),
      };
    }
    case "inworld-mine": {
      const data = await ctx.client.get<{ data?: Array<Record<string, unknown>> }>(
        "/api/v1/inworld/my-cloned-voices",
      );
      const voices: NormalizedVoice[] = (data.data ?? []).map((v) => ({
        id: String(v.voice_id ?? v.id ?? ""),
        name: String(v.name ?? v.display_name ?? "Cloned voice"),
        language: typeof v.language === "string" && v.language ? v.language : undefined,
        description: typeof v.description === "string" && v.description ? v.description : undefined,
      }));
      return { voices, facets: {}, fetchedAt: Date.now() };
    }
    default:
      throw new Error(`No dynamic catalog for provider ${provider}`);
  }
}

function staticCatalog(provider: VoiceProvider): CachedCatalog {
  const voices = STATIC_CATALOGS[provider] ?? [];
  const facets: CachedCatalog["facets"] = {};
  const langs = unique(voices.map((v) => v.language).filter(Boolean) as string[]);
  const genders = unique(voices.map((v) => v.gender).filter(Boolean) as string[]);
  if (langs.length > 0) facets.languages = langs;
  if (genders.length > 0) facets.genders = genders;
  return { voices, facets, fetchedAt: Date.now() };
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

// --- Filtering ---

function matchesFilters(
  v: NormalizedVoice,
  filters: { query?: string; language?: string; gender?: string; accent?: string; tag?: string },
): boolean {
  if (filters.query) {
    const q = filters.query.toLowerCase();
    const hay = [v.id, v.name, v.description, v.gender, v.language, v.accent, ...(v.tags ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filters.language) {
    const want = filters.language.toLowerCase();
    const have = (v.language ?? "").toLowerCase();
    const langs = Array.isArray((v as Record<string, unknown>).languages)
      ? ((v as Record<string, unknown>).languages as string[]).map((l) => l.toLowerCase())
      : [];
    if (have !== want && !langs.includes(want)) return false;
  }
  if (filters.gender) {
    if ((v.gender ?? "").toLowerCase() !== filters.gender.toLowerCase()) return false;
  }
  if (filters.accent) {
    if ((v.accent ?? "").toLowerCase() !== filters.accent.toLowerCase()) return false;
  }
  if (filters.tag) {
    const tags = (v.tags ?? []).map((t) => t.toLowerCase());
    if (!tags.includes(filters.tag.toLowerCase())) return false;
  }
  return true;
}

// --- Tool ---

const versely_list_voices = defineTool({
  name: "versely_list_voices",
  description: [
    "List available TTS voices for any supported provider. Two use cases:",
    "  1. Resolving a voice ID before a TTS call — never ask the user for one;",
    "     call this with a query/filter, pick a voice, pass its `id` to versely_generate_audio.",
    "  2. Answering 'what voices do you have?' / 'show me british female voices' /",
    "     'what languages does Inworld support?' — call with the matching provider and",
    "     filters, then summarize results for the user.",
    "",
    "CRITICAL — picking a voice from the response:",
    "  • Pass the voice's `id` field as the value (NOT `name`). e.g. for ElevenLabs",
    "    'Margot' { id: 'XB0fDUnXU5powFXDhCwa', name: 'Margot' } you pass",
    "    `voice: 'XB0fDUnXU5powFXDhCwa'` — passing 'Margot' will fail with no taskId.",
    "  • The response's `voice_field` tells you the body field name to use",
    "    (`voice` vs `voice_id`). Do not guess.",
    "",
    "Provider → audio model(s) it serves + the body field name to pass:",
    ...Object.entries(PROVIDER_META).map(
      ([k, m]) => `  • ${k} → ${m.models.join(", ")} (body field: \`${m.voiceField}\`)`,
    ),
    "",
    "Use `query` for substring search (matches id, name, description, gender, language, accent, tags).",
    "Backend libraries (elevenlabs ~5000, cartesia ~1500, inworld ~70) are paginated via `limit`/`offset`.",
    "Response includes a `facets` block listing the available filter values (languages, genders, accents, tags) so you can refine without guessing.",
  ].join("\n"),
  inputSchema: z.object({
    provider: z.enum([
      "elevenlabs",
      "elevenlabs-library",
      "elevenlabs-saved",
      "cartesia",
      "cartesia-mine",
      "inworld",
      "inworld-mine",
      "minimax",
      "gemini",
      "suno",
      "qwen",
      "grok",
      "chatterbox",
    ]),
    query: z
      .string()
      .optional()
      .describe("Case-insensitive substring filter across id, name, description, gender, language, accent, tags."),
    language: z.string().optional().describe("Filter by language (case-insensitive)."),
    gender: z.string().optional().describe("Filter by gender (e.g. 'male', 'female')."),
    accent: z.string().optional().describe("Filter by accent (ElevenLabs only)."),
    tag: z.string().optional().describe("Filter by tag (Inworld only)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Max voices to return. Default 25, max 100."),
    offset: z.number().int().nonnegative().optional().describe("Pagination offset. Default 0."),
    refresh: z
      .boolean()
      .optional()
      .describe("Bust the per-process cache for dynamic providers and re-fetch."),
  }),
  handler: async (input, ctx) => {
    const provider = input.provider as VoiceProvider;
    const meta = PROVIDER_META[provider];
    const limit = Math.min(input.limit ?? 25, 100);
    const offset = input.offset ?? 0;

    let catalog: CachedCatalog;
    if (STATIC_CATALOGS[provider]) {
      catalog = staticCatalog(provider);
    } else {
      const userId =
        provider === "elevenlabs-saved" ||
        provider === "cartesia-mine" ||
        provider === "inworld-mine"
          ? await ctx.client.getCurrentUserId()
          : undefined;
      const key = cacheKey(provider, userId);
      const cached = !input.refresh ? readCache(key) : null;
      if (cached) {
        catalog = cached;
      } else {
        catalog = await fetchDynamicCatalog(ctx, provider);
        catalogCache.set(key, catalog);
      }
    }

    const filters = {
      query: input.query,
      language: input.language,
      gender: input.gender,
      accent: input.accent,
      tag: input.tag,
    };
    const matched = catalog.voices.filter((v) => matchesFilters(v, filters));
    const page = matched.slice(offset, offset + limit);

    const example =
      page[0]?.id !== undefined
        ? `versely_generate_audio({ model: "${meta.models[0]}", text: "...", ${meta.voiceField}: "${page[0].id}" })`
        : `versely_generate_audio({ model: "${meta.models[0]}", text: "...", ${meta.voiceField}: "<voices[i].id>" })`;

    const payload = {
      provider,
      voice_field: meta.voiceField,
      models: meta.models,
      blurb: meta.blurb,
      usage: `When you pick a voice from this list, pass its \`id\` field (NOT \`name\`) as the \`${meta.voiceField}\` field to versely_generate_audio. Example: ${example}`,
      total_available: catalog.voices.length,
      total_matched: matched.length,
      returned: page.length,
      offset,
      limit,
      has_more: offset + page.length < matched.length,
      voices: page,
      facets: catalog.facets,
    };

    return jsonResult(payload);
  },
});

export const voiceTools: Tool[] = [versely_list_voices];
