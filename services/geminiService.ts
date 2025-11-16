
// FIX: Added Modality and Part to imports for TTS and generic content parts.
import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold, GenerateContentResponse, Modality, Part } from "@google/genai";
import { base64ToBytes } from "../utils/fileUtils";
import { parseErrorMessage } from "../utils/errorUtils";

// Add Character type to be used in App.tsx
export type Character = {
  id: number;
  name: string;
  imagePreview: string | null;
  originalImageBase64: string | null; // New field for the original base64 image data
  originalImageMimeType: string | null; // New field for the original image MIME type
  description: string | null;
  detectedImageStyle: string | null; // New field for the style of the uploaded image
  isDescribing: boolean;
};

// FIX: Added and exported AudioOptions type.
export type AudioOptions = {
    mode: 'upload';
    data: string; // base64
    mimeType: string;
    assignment?: { type: 'character'; characterName: string } | { type: 'background' };
} | {
    mode: 'tts';
    data: string; // script prompt
};

export type EditImageParams = {
  imageBase64: string;
  mimeType: string;
  editPrompt: string;
  aspectRatio: string;
  imageStyle: string;
  genre: string;
  characters: Character[];
};

const getAiClient = () => {
    const API_KEY = process.env.API_KEY;
    if (!API_KEY) {
      throw new Error("API_KEY environment variable not set");
    }
    return new GoogleGenAI({ apiKey: API_KEY });
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry<T>(apiCall: () => Promise<T>, onRetryMessage?: (msg: string) => void): Promise<T> {
    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries) {
        try {
            return await apiCall();
        } catch (error) {
            attempt++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isRetryable = errorMessage.includes('503') || errorMessage.toLowerCase().includes('overloaded') || errorMessage.includes('429');

            if (isRetryable && attempt < maxRetries) {
                const delaySeconds = Math.pow(2, attempt) * 15; // 30s, 60s
                const retryMsg = `Model is busy. Retrying in ${delaySeconds}s... (Attempt ${attempt}/${maxRetries})`;
                if (onRetryMessage) {
                    onRetryMessage(retryMsg);
                } else {
                    console.log(retryMsg);
                }
                await delay(delaySeconds * 1000);
            } else {
                throw error;
            }
        }
    }
    throw new Error("API call failed after multiple retries.");
}


export type StoryboardScene = {
    src: string | null;
    prompt: string;
    error?: string | null;
    isCameraAngleFor?: number; // Index of the parent scene
};

export type GenerationResult = {
    storyboard: StoryboardScene[];
}

const CAMERA_MOVEMENT_PROMPTS: { [key: string]: string } = {
    'Static Hold': 'The camera remains completely static, holding a fixed shot on the scene.',
    'Drone Rise Tilt-Up': 'The camera starts low and ascends smoothly while tilting upward, creating an epic aerial reveal of the scene.',
    'Dolly Back (Pull-Out)': 'The camera starts relatively close to the subject and then moves straight backward (dolly out), smoothly revealing more of the surrounding environment.',
    'Pan Left': 'The camera moves smoothly and horizontally from right to left across the scene.',
    'Pan Right': 'The camera moves smoothly and horizontally from left to right across the scene.',
    'Orbit Around Subject': 'The camera smoothly circles around the main subject of the scene, keeping them in focus.',
    'Crane Down': 'The camera moves vertically downward, as if on a crane, offering a descending perspective of the scene.',
    'Crane Up': 'The camera moves vertically upward, as if on a crane, for a powerful lift or establishing shot.',
    'Tracking Shot (Follow)': 'The camera follows the subject\'s motion smoothly, keeping them at a consistent position in the frame.',
    'Zoom In (Focus In)': 'The camera lens smoothly zooms in, gradually tightening the focus on the main subject or a specific detail.',
    'Zoom Out (Reveal)': 'The camera lens smoothly zooms out, gradually widening the view to reveal more of the setting or context.',
};

export async function generateCharacterDescription(imageBase64: string, mimeType: string): Promise<{ description: string; detectedStyle: string }> {
    const ai = getAiClient();
    const imagePart = { inlineData: { data: imageBase64, mimeType }};
    const prompt = `Analyze the person in the image. Generate a concise, single-line, comma-separated list of descriptive tags for an AI image generator to ensure high-fidelity recreation. Also, identify the primary visual art style of the character in the image from the following options: "Nigerian Cartoon", "Cartoon (Big Head)", "Illustration", "3D Render", "Realistic Photo", "Oil Painting", "Pixel Art", "2D Flat", "Anime", "Clip Art", "Video Game", "Pastel Sketch", "Dark Fantasy", "Cyberpunk", "Steampunk", "Watercolor", "Art Nouveau". If the style doesn't fit exactly, choose the closest or provide a brief custom description.

    **CRITICAL RULES:**
    1.  **Format:** Return a JSON object with two keys: "description" (string) and "detectedStyle" (string).
    2.  **Description Content:** Include gender, estimated age, ethnicity, face shape, eye color/shape, hair color/style, skin tone, and any highly distinctive features (e.g., beard, glasses, specific clothing if iconic). This should be a compact "character token" suitable for embedding.
    3.  **Detected Style Content:** Choose one style from the provided list, or describe it concisely if not on the list.

    **Example Output:**
    {
        "description": "woman, early 30s, West African, round face, dark brown eyes, long black braids, dark brown skin, wearing gold hoop earrings",
        "detectedStyle": "Realistic Photo"
    }`;


    const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: { parts: [imagePart, { text: prompt }]},
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    description: { type: Type.STRING },
                    detectedStyle: { type: Type.STRING }
                },
                required: ['description', 'detectedStyle']
            }
        }
    }));

    const text = response.text;
    if (typeof text !== 'string') {
        console.error("generateCharacterDescription received no text in response:", JSON.stringify(response, null, 2));
        throw new Error("Failed to get a valid text response from the AI. The prompt may have been blocked or the model returned an empty result.");
    }

    try {
        const parsed = JSON.parse(text);
        return { description: parsed.description.trim(), detectedStyle: parsed.detectedStyle.trim() };
    } catch (e) {
        console.error("Failed to parse JSON response from character description:", text, e);
        throw new Error("Failed to get a valid JSON response from the AI for character description.");
    }
}

export async function describeImageForConsistency(imageBase64: string): Promise<string> {
    const ai = getAiClient();
    const imagePart = { inlineData: { data: imageBase64, mimeType: 'image/png' }};
    const prompt = `You are an expert scene analyst for an AI image generator. Your task is to generate a very concise, comma-separated list of descriptive tags for the provided image.

**CRITICAL RULES:**
1.  **Format:** A single line of comma-separated tags. **DO NOT** use sentences, paragraphs, or labels (e.g., "Character:", "Setting:").
2.  **Content:** Focus only on the most essential visual elements needed for recreation:
    *   **Subject:** Main character(s) and their core features (e.g., 'boy with red shirt').
    *   **Setting:** The immediate environment (e.g., 'in a classroom', 'at a desk').
    *   **Atmosphere:** Key lighting and mood (e.g., 'sunny day', 'dim lighting').
3.  **Brevity:** The entire output should be as short as possible while preserving the scene's essence. Aim for keywords over full descriptions.
4.  **Goal:** Create a compact "scene token" that can be directly embedded into a larger prompt.

**Example:** boy with blue shirt, sitting at a wooden desk, classroom, bright daylight, simple cartoon style.`;

    const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: { parts: [imagePart, { text: prompt }]}
    }));

    return response.text.trim();
}


async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
    const ai = getAiClient();
    const audioPart = { inlineData: { data: audioBase64, mimeType: mimeType } };
    const prompt = `Transcribe the audio recording. Provide only the text of the speech. If there is no speech, return an empty string.`;

    const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: { parts: [audioPart, { text: prompt }] },
    }));

    return response.text.trim();
}

export async function generatePromptFromAudio(audioBase64: string, mimeType: string): Promise<string> {
    return await transcribeAudio(audioBase64, mimeType);
}


async function generatePromptsFromBase(
  basePrompt: string,
  sceneCount: number,
  genre: string,
  characters: Character[] // Updated type to full Character array
): Promise<string[]> {
    const ai = getAiClient();
    const genreInstruction = genre && genre.toLowerCase() !== 'general' 
        ? `**Genre:** The story must be in the **${genre}** genre.` 
        : '';
    
    let characterInstruction = '';
    if (characters.length > 0) {
        const characterDetails = characters
            .filter(c => c.name && c.description)
            .map(c => `  - ${c.name}: ${c.description}`)
            .join('\n');
        characterInstruction = `**Defined Characters:** You have been provided with descriptions for the following characters. When these names appear in the story, you MUST adhere strictly to their visual descriptions.\n${characterDetails}\n\n**Implicit Characters:** If other names appear in the user's core idea that are not in the list above, treat them as new characters and ensure they are included in the scene descriptions. Generate a consistent appearance for them throughout the scenes.`;
    }

    const racialInstruction = `**RACIAL MANDATE:** ALL human characters in the story and scene descriptions MUST be of Black African descent. Ensure the setting, cultural elements, and descriptions reflect this.`;

    const prompt = `You are a creative assistant generating prompts for an image AI. Your primary goal is to create safe, clear, and visually descriptive scenes.

    **Task:** Based on the user's core idea, create ${sceneCount} sequential scene descriptions.

    ${racialInstruction}

    **Core Idea:** "${basePrompt}"
    ${genreInstruction}
    ${characterInstruction}

    **CRITICAL SAFETY & CLARITY RULES:**
    1.  **Language:** Use simple, direct, and unambiguous language. Describe only what should be physically visible in the image.
    2.  **Prohibited Content:** STRICTLY AVOID any mention, hint, or description of violence, weapons, conflict, aggression, political themes, social commentary, or any sensitive topics that could be misinterpreted by a safety filter.
    3.  **Focus:** Concentrate on positive or neutral actions, settings, and character interactions.
    4.  **Goal:** The final prompts must be 100% safe-for-work and family-friendly.

    The output must be a JSON object containing an array of these safe, visual prompts.`;
    
    const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: { parts: [{text: prompt }] },
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    prompts: {
                        type: Type.ARRAY,
                        description: `An array of ${sceneCount} unique and descriptive image prompts that form a coherent story, following all safety rules.`,
                        items: {
                            type: Type.STRING,
                            description: 'A simple, safe, and detailed visual description for a single story scene.'
                        }
                    }
                },
                required: ['prompts']
            }
        }
    }));
    
    const jsonStr = response.text.trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed.prompts || !Array.isArray(parsed.prompts) || parsed.prompts.length === 0) {
        throw new Error("AI failed to return a valid array of prompts.");
    }
    
    return parsed.prompts;
}

function isCartoonStyle(style: string): boolean {
    const cartoonKeywords = ['cartoon', '2d flat', 'anime', 'pixel art', 'illustration', 'clip art', 'video game', 'pastel sketch'];
    return cartoonKeywords.some(keyword => style.toLowerCase().includes(keyword));
}

export async function generateSingleImage(
    prompt: string,
    aspectRatio: string,
    imageStyle: string, // User selected style from UI
    genre: string,
    charactersForPrompt: Character[], // Characters for prompt content (descriptions) - now full Character array
    allCharactersWithStyles: Character[], // Full character objects to access detectedImageStyle AND original image data
    imageModel: string,
    referenceImageSrc?: string | null,
    referenceDescriptionOverride?: string | null
): Promise<{ src: string | null; error: string | null }> {
    const ai = getAiClient();
    try {
        let referenceDescription = '';
        if (referenceDescriptionOverride) {
            referenceDescription = referenceDescriptionOverride;
        } else if (referenceImageSrc) {
            referenceDescription = await describeImageForConsistency(referenceImageSrc);
        }

        let charImageToIntegrate: { charId: number; base64: string; mimeType: string } | null = null;
        let forceNanoBanana = false;
        let characterIntegrityInstruction = '';

        const charForImageRef = allCharactersWithStyles.find(c => c.originalImageBase64 && c.originalImageMimeType);

        if (charForImageRef) {
            charImageToIntegrate = {
                charId: charForImageRef.id,
                base64: charForImageRef.originalImageBase64!,
                mimeType: charForImageRef.originalImageMimeType!,
            };
            forceNanoBanana = true; 
            
            characterIntegrityInstruction = `You are an expert at high-fidelity character recreation. You have been given a **Character Reference Image**. Your task is to place this character into a new scene.

**CRITICAL RULES:**
1.  **Absolute Character Integrity:** This is your highest priority. The character in the output image MUST be a perfect visual match to the character in the **Character Reference Image**. You MUST preserve their exact original design, appearance, clothing, and identity. Do NOT change their features or art style in any way.
2.  **Seamless Scene Integration:** Place this exact character into the scene based on the main "SCENE" prompt. You must adjust the character's pose, position, and lighting to make them fit naturally within the new environment, but their core appearance and clothing MUST remain unchanged.
3.  **Final Style:** The final, composite image MUST be rendered in a '${imageStyle}' style.
---
`;
        }

        let finalCharacterBlock = '';
        let charactersForTextDescription = charactersForPrompt;

        if (charImageToIntegrate) {
            charactersForTextDescription = charactersForPrompt.filter(
                c => c.id !== charImageToIntegrate!.charId
            );
        }

        if (charactersForTextDescription.length > 0) {
            const characterDescriptions = charactersForTextDescription.map(c => `- **${c.name}**: ${c.description}`).join('\n');
            finalCharacterBlock = `---
**DEFINED CHARACTERS (CRITICAL & ABSOLUTE REQUIREMENT):**
The generated image features one or more characters. For any character whose name is listed below, it is absolutely essential that you generate a high-fidelity visual representation based on their provided description.

**GENDER & IDENTITY:** Pay extremely close attention to the specified gender. If the description says "woman", you MUST generate a woman. If it says "man", you MUST generate a man. This is a non-negotiable instruction. Any deviation from the specified gender is a complete failure.

**PHYSICAL FEATURES:** Adhere strictly to all other specified features like age, ethnicity, hair, and eye color.

**List of Defined Characters:**
${characterDescriptions}

**For any other characters mentioned in the SCENE prompt but not listed above, create a visually appropriate appearance for them.**
---
`;
        }
        
        let styleInstructions: string;
        if (imageStyle === 'Cartoon (Big Head)') {
            styleInstructions = `A funny 2D vector art cartoon in an Adobe Illustrator style. Characters have exaggerated proportions: a very large head, a tiny waist, and small legs. Use bold outlines and flat colors, avoiding 3D effects, shadows, or gradients.`;
        } else if (imageStyle === 'Nigerian Cartoon') {
            styleInstructions = `A vibrant 2D cartoon style inspired by Nigerian art. Characters are drawn as caricatures with expressive faces and large heads. They wear colorful traditional Nigerian attire like agbada, kaftans, or gele. The art uses bold, clean outlines and a simple, flat color palette, creating a lively and humorous feel. This is not a realistic or 3D style.`;
        } else {
            styleInstructions = `In the style of ${imageStyle}.`;
        }
        
        const genreInstruction = genre && genre.toLowerCase() !== 'general' ? genre : '';
        
        const visualReferencePreamble = referenceDescription
            ? `\n---
**VISUAL CONSISTENCY MANDATE:**
The entire scene (character, background, lighting, and atmosphere) must be visually consistent with the following detailed description. Recreate this scene exactly, but from the new perspective requested in the SCENE section.
**Reference Scene Description:**
${referenceDescription}
---
`
            : '';
        
        const racialMandate = `---
**RACIAL MANDATE (CRITICAL & ABSOLUTE REQUIREMENT):**
ALL human characters depicted in the image MUST be of Black African descent. This is a non-negotiable instruction. If the prompt, scene description, or character descriptions ask for or describe a non-Black person, you MUST ignore that specific racial trait and render them as a Black person, while keeping all other characteristics (like clothing, pose, expression) the same.
---
`;
        
        let contentsParts: Part[];
        const isNanoBanana = imageModel === 'gemini-2.5-flash-image' || forceNanoBanana;
        const aspectRatioInstruction = isNanoBanana ? `\n**ASPECT RATIO (CRITICAL):** The image must be generated in a ${aspectRatio} aspect ratio.` : '';


        if (charImageToIntegrate && forceNanoBanana) {
            let integrationTextPrompt = `${characterIntegrityInstruction}${racialMandate}${finalCharacterBlock}${visualReferencePreamble}

**SCENE:** "${prompt}"
**IMAGE_STYLE_GUIDE:** ${styleInstructions}${aspectRatioInstruction}`;
            if (genreInstruction) {
                integrationTextPrompt += `\n**GENRE:** ${genreInstruction}`;
            }
            contentsParts = [
                { inlineData: { data: charImageToIntegrate.base64, mimeType: charImageToIntegrate.mimeType } },
                { text: integrationTextPrompt }
            ];
        } else {
            let baseTextPrompt = `${racialMandate}${finalCharacterBlock}${visualReferencePreamble}\n**SCENE:** "${prompt}"\n**IMAGE_STYLE_GUIDE:** ${styleInstructions}${aspectRatioInstruction}`;
            if (genreInstruction) {
                 baseTextPrompt += `\n**GENRE:** ${genreInstruction}`;
            }
            contentsParts = [{ text: baseTextPrompt }];
        }
        
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];
        
        if (isNanoBanana) {
            const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
                model: 'gemini-2.5-flash-image',
                contents: { parts: contentsParts }, 
                config: {
                    responseModalities: [Modality.IMAGE],
                },
                safetySettings: safetySettings, 
            }));

            for (const part of response.candidates?.[0]?.content?.parts || []) {
                if (part.inlineData) {
                    return { src: part.inlineData.data, error: null };
                }
            }
            console.warn(`gemini-2.5-flash-image call was successful but returned no image. Full response:`, response);
            return { src: null, error: 'The model returned a success status but no image data. This may be due to a safety filter or an issue with the complexity of the prompt. Please try a different prompt.' };
        }

        const response: any = await withRetry(() => ai.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt: (contentsParts[0] as {text: string}).text,
            config: {
                numberOfImages: 1,
                aspectRatio: aspectRatio,
                outputMimeType: 'image/png',
            },
            safetySettings: safetySettings, 
        }));

        
        if (response && response.generatedImages && response.generatedImages.length > 0 && response.generatedImages[0].image?.imageBytes) {
            return { src: response.generatedImages[0].image.imageBytes, error: null };
        } else {
            console.warn(`Image call was successful but returned no image. Full response:`, response);
            return { src: null, error: 'The model returned a success status but no image data. This may be due to a safety filter or an issue with the complexity of the prompt. Please try a different prompt.' };
        }
    } catch (error) {
        const parsedError = parseErrorMessage(error);
        console.error(`Image could not be generated and will be skipped:`, parsedError);
        return { src: null, error: parsedError };
    }
}


async function generateImagesFromPrompts(
  prompts: string[],
  aspectRatio: string,
  imageStyle: string,
  genre: string,
  charactersForPrompt: Character[], // For prompt content - now full Character array
  allCharactersWithStyles: Character[], // Full character objects to access detectedImageStyle
  imageModel: string,
  onProgress: (message: string) => void
): Promise<StoryboardScene[]> {
    const scenes: StoryboardScene[] = [];
    
    for (let i = 0; i < prompts.length; i++) {
        onProgress(`Generating image ${i + 1} of ${prompts.length}...`);
        
        const { src, error } = await generateSingleImage(prompts[i], aspectRatio, imageStyle, genre, charactersForPrompt, allCharactersWithStyles, imageModel);
        scenes.push({ prompt: prompts[i], src, error });

        if (i < prompts.length - 1) {
            onProgress(`Pausing to avoid rate limits...`);
            await delay(15000);
        }
    }
  
  return scenes;
}


export async function generateImageSet(
  promptText: string,
  imageCount: number,
  aspectRatio: string,
  imageStyle: string,
  genre: string,
  charactersForPrompt: Character[], // Characters for prompt content - now full Character array
  allCharactersWithStyles: Character[], // Full characters array to pass to generateImagesFromPrompts
  imageModel: string,
  onProgress: (message: string) => void
): Promise<GenerationResult> {
  
  try {
    onProgress("Breaking down the story into scenes...");
    const scenePrompts = await generatePromptsFromBase(promptText, imageCount, genre, charactersForPrompt);
    const storyboard = await generateImagesFromPrompts(scenePrompts, aspectRatio, imageStyle, genre, charactersForPrompt, allCharactersWithStyles, imageModel, onProgress);
    return { storyboard };
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    if (error instanceof Error) {
        throw new Error(parseErrorMessage(error));
    }
    throw new Error("An unknown error occurred during image set generation.");
  }
}

async function analyzeEnvironmentForCameraPlacement(
    imageBase64: string,
    angles: string[] // e.g., ['back', 'side']
): Promise<Record<string, string>> {
    const ai = getAiClient();
    const imagePart = { inlineData: { data: imageBase64, mimeType: 'image/png' } };

    const prompt = `You are a virtual cinematographer analyzing a scene to find the best camera placements. Analyze the provided image. Your task is to determine the most natural camera positions to achieve specific views of the main subject.

    **Analysis Steps:**
    1.  **Identify Subject & Orientation:** Locate the main character and note the direction they are facing.
    2.  **Describe Environment:** Briefly map out the key objects and walls around the subject.
    3.  **Determine Placements:** Based on the environment, describe the most logical and physically possible camera placements to achieve the requested views: ${angles.join(', ')}. The camera cannot be placed inside solid objects.

    **CRITICAL RULE: Scene Integrity**
    When describing the new camera perspective, you MUST instruct the AI to ONLY move the camera. The position, orientation, and pose of ALL scene elements (characters, furniture, vehicles, buildings, environment, etc.) must remain absolutely unchanged. The scene must be identical, just viewed from a different angle.

    **Output Format:**
    Your response MUST be a valid JSON object. For each requested angle (e.g., "back"), create a key named \`\${angle}_view_prompt\` (e.g., "back_view_prompt"). The value for each key must be a concise instruction for an image generation AI that strictly adheres to the "Scene Integrity" rule.

    **Example Request:** angles = ["back", "side"]
    **Example JSON Output:**
    {
      "back_view_prompt": "Render the scene from a camera placed directly behind the character, showing the back of their head and the computer monitor they are looking at. The character's pose and all elements in the room must remain in their original, unchanged positions.",
      "side_view_prompt": "Render the scene from a camera placed to the character's left, near the window, capturing their side profile as they sit at the desk. The character's pose and all elements in the room must remain in their original, unchanged positions."
    }`;

    // Dynamically create the schema properties based on the requested angles
    const properties: { [key: string]: { type: Type, description: string } } = {};
    const required: string[] = [];
    angles.forEach(angle => {
        const key = `${angle}_view_prompt`;
        properties[key] = {
            type: Type.STRING,
            description: `The detailed prompt for generating the ${angle} view.`
        };
        required.push(key);
    });

    const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-pro', // Using Pro for better spatial reasoning
        contents: { parts: [imagePart, { text: prompt }] },
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties,
                required,
            }
        }
    }));

    try {
        const jsonStr = response.text.trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("Failed to parse camera placement analysis JSON:", response.text, e);
        throw new Error("AI failed to return a valid camera placement plan.");
    }
}

export async function generateCameraAnglesFromImage(
    referenceScene: StoryboardScene,
    generationInfo: {
      aspectRatio: string;
      imageStyle: string;
      genre: string;
      characters: Character[];
      imageModel: string;
    },
    angleNames: string[],
    onProgress: (message: string) => void
  ): Promise<StoryboardScene[]> {
    if (!referenceScene.src) {
      throw new Error("Reference scene is missing image source.");
    }
  
    // Step 1: Extend the image to get a wider scene context.
    onProgress(`Extending original image...`);
    const outpaintPrompt = "Perform 'outpainting' on this image. Extend the image on all sides to reveal more of the surrounding environment. Fill in the new areas naturally, seamlessly blending with the existing content, style, and lighting. Do not alter any of the original pixels. The goal is to create a wider, more complete view of the scene.";

    const { src: extendedImageSrc, error: extensionError } = await editImage({
        imageBase64: referenceScene.src,
        mimeType: 'image/png',
        editPrompt: outpaintPrompt,
        ...generationInfo,
    });

    if (extensionError || !extendedImageSrc) {
        console.error("Failed to extend image for camera angle generation:", extensionError);
        throw new Error(`Could not extend the base image: ${extensionError || 'Unknown error'}`);
    }

    // Step 2: Analyze the extended environment to find natural camera positions.
    onProgress(`Analyzing extended environment...`);
    // Filter out 'front' as it doesn't need complex placement analysis.
    const anglesToAnalyze = angleNames.filter(name => name !== 'front');
    let cameraPrompts: Record<string, string> = {};

    if (anglesToAnalyze.length > 0) {
        cameraPrompts = await analyzeEnvironmentForCameraPlacement(extendedImageSrc, anglesToAnalyze);
    }
    
    if (angleNames.includes('front')) {
        cameraPrompts['front_view_prompt'] = "Render the scene from a direct front-on camera angle, facing the main character. The character's pose and the room's layout remain unchanged."
    }

    const generatedScenes: StoryboardScene[] = [];

    // Step 3: Generate each view using the new prompts and the extended image.
    for (let i = 0; i < angleNames.length; i++) {
        const angle = angleNames[i];
        const anglePromptKey = `${angle}_view_prompt`;
        const finalEditPrompt = cameraPrompts[anglePromptKey];

        if (!finalEditPrompt) {
            console.warn(`No camera prompt generated for angle: ${angle}`);
            generatedScenes.push({ prompt: `Failed to generate prompt for ${angle} view`, src: null, error: `AI analysis did not provide a prompt for the ${angle} view.` });
            continue;
        }

        onProgress(`Generating '${angle}' view... (${i + 1}/${angleNames.length})`);
        
        const { src: newImageSrc, error: newError } = await editImage({
          imageBase64: extendedImageSrc, // Use the extended image as the base for all angles
          mimeType: 'image/png',
          editPrompt: finalEditPrompt,
          ...generationInfo,
        });

        generatedScenes.push({ prompt: finalEditPrompt, src: newImageSrc, error: newError });

        if (i < angleNames.length - 1) {
          onProgress(`Pausing before next angle...`);
          await delay(15000);
        }
    }
    return generatedScenes;
}

export async function editImage(params: EditImageParams): Promise<{ src: string | null; error: string | null }> {
    const { imageBase64, mimeType, editPrompt, aspectRatio, imageStyle, genre, characters } = params;
    const ai = getAiClient();

    try {
        const contentsParts: Part[] = [];
        const imageToEditPart = { inlineData: { data: imageBase64, mimeType } };
        contentsParts.push(imageToEditPart);

        const charForImageRef = characters.find(c => c.originalImageBase64 && c.originalImageMimeType);
        let finalPromptText = "";

        if (charForImageRef) {
            const charRefImagePart = { inlineData: { data: charForImageRef.originalImageBase64!, mimeType: charForImageRef.originalImageMimeType! } };
            contentsParts.push(charRefImagePart);
            
            finalPromptText = `You are an expert AI image editor. You have been given two images: an input "Scene Image" to modify, and a "Character Reference Image".

**EDIT INSTRUCTION:** "${editPrompt}"

**CRITICAL RULES:**
1.  **Apply Edit to Scene:** Apply the "EDIT INSTRUCTION" to the "Scene Image".
2.  **Enforce Character Consistency:** The character in the final, edited image MUST be a perfect visual match to the character in the "Character Reference Image". Preserve their exact appearance, clothing, and identity. This is your highest priority.
3.  **Maintain Style & Scene:** Preserve the overall art style, lighting, and background elements of the original "Scene Image" unless the edit instruction specifically asks to change them. The final style must be: "${imageStyle}".
4.  **Maintain Aspect Ratio:** The output image must have the same aspect ratio: ${aspectRatio}.
`;
        } else {
            finalPromptText = `You are an expert AI image editor. Your task is to modify the provided image based on the user's instructions.

**EDIT INSTRUCTION:** "${editPrompt}"

**CRITICAL RULES:**
1.  **Preserve Identity:** You MUST preserve the core identity, features, and style of the original image and any characters within it. Only apply the specific change requested.
2.  **Maintain Style:** The edited image's art style must perfectly match the original. The style is: "${imageStyle}".
3.  **Maintain Aspect Ratio:** The output image must have the same aspect ratio as the input: ${aspectRatio}.
`;
        }

        const racialMandate = `---
**RACIAL MANDATE (CRITICAL & ABSOLUTE REQUIREMENT):**
ALL human characters depicted in the image MUST be of Black African descent.
---
`;
        
        const otherCharacters = characters.filter(c => c.id !== charForImageRef?.id && c.name && c.description);
        const otherCharacterBlock = otherCharacters.length > 0 ? `---
**OTHER CHARACTERS:**
The edited image must also maintain the appearance of these other characters based on their text descriptions:
${otherCharacters.map(c => `- **${c.name}**: ${c.description}`).join('\n')}
---
` : '';

        finalPromptText += `\n${racialMandate}\n${otherCharacterBlock}`;
        contentsParts.push({ text: finalPromptText });

        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];

        const response: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: contentsParts },
            config: {
                responseModalities: [Modality.IMAGE],
            },
            safetySettings: safetySettings,
        }));

        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                return { src: part.inlineData.data, error: null };
            }
        }
        
        return { src: null, error: 'The model did not return an edited image. The edit may have been rejected by a safety filter.' };

    } catch (error) {
        const parsedError = parseErrorMessage(error);
        console.error(`Image could not be edited:`, parsedError);
        return { src: null, error: parsedError };
    }
}


async function generateSpeech(
    script: string,
    characters: Character[],
    imageStyle: string
): Promise<string | null> {
    const ai = getAiClient();
    if (!script) return null;

    const knownCharacters = characters.filter(c => c.name).map(c => c.name);
    const allPossibleSpeakers = ['Narrator', ...knownCharacters];
    
    const speakerMatches = Array.from(script.matchAll(/^([\w\s]+):/gm));
    const detectedSpeakers = new Set<string>();

    speakerMatches.forEach(match => {
        const speakerName = match[1].trim();
        const foundSpeaker = allPossibleSpeakers.find(s => s.toLowerCase() === speakerName.toLowerCase());
        if (foundSpeaker) {
            detectedSpeakers.add(foundSpeaker);
        }
    });

    try {
        if (detectedSpeakers.size > 1) {
            // Multi-speaker logic
            const availableVoices = ['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir'];
            const speakerVoiceConfigs = Array.from(detectedSpeakers).map((name, index) => ({
                speaker: name,
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: availableVoices[index % availableVoices.length] as any }
                }
            }));

            const ttsPrompt = `TTS the following conversation:\n${script}`;
            
            const ttsResponse: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: ttsPrompt }] }],
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        multiSpeakerVoiceConfig: { speakerVoiceConfigs }
                    }
                }
            }));
            const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            return base64Audio || null;
        } else {
            // Single-speaker or Narrator logic
            let ttsPrompt = script;
            if (imageStyle === 'Nigerian Cartoon') {
                ttsPrompt = `You are a Nigerian voice actor. Speak the following text in a lively and authentic Nigerian Pidgin English accent: "${script}"`;
            } else {
                ttsPrompt = `Say with a clear and engaging voice: ${script}`;
            }
            
            const singleSpeakerName = detectedSpeakers.size === 1 ? Array.from(detectedSpeakers)[0] : 'Narrator';
            const speakerVoice = singleSpeakerName === 'Narrator' ? 'Kore' : 'Puck';

            const ttsResponse: GenerateContentResponse = await withRetry(() => ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: ttsPrompt }] }],
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: speakerVoice as any } },
                    },
                },
            }));
            const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            return base64Audio || null;
        }
    } catch (err) {
        console.error("TTS generation failed:", err);
        throw new Error(`TTS generation failed: ${parseErrorMessage(err)}`);
    }
}

export async function generateVideoFromScene(
    scene: StoryboardScene,
    aspectRatio: string,
    script: string,
    characters: Character[],
    audioOptions: AudioOptions | null,
    imageStyle: string,
    videoModel: string,
    videoResolution: '720p' | '1080p',
    cameraMovement: string,
    onProgress: (message: string) => void
): Promise<{ videoUrl: string; audioUrl: string | null; videoObject: any, audioBase64: string | null }> {
    const ai = getAiClient();
    if (!scene || !scene.src) {
        throw new Error("Cannot generate video from an empty or failed scene.");
    }
    
    const audioDataPromise = (async (): Promise<{ audioUrl: string | null, audioBase64: string | null }> => {
        if (!audioOptions) return { audioUrl: null, audioBase64: null };
        onProgress("Generating voiceover...");
        try {
            let audioBase64: string | null = null;
            if (audioOptions.mode === 'upload') {
                audioBase64 = audioOptions.data;
            } else if (audioOptions.mode === 'tts' && audioOptions.data) {
                audioBase64 = await generateSpeech(audioOptions.data, characters, imageStyle);
            }

            if (audioBase64) {
                const audioBytes = base64ToBytes(audioBase64);
                const audioBlob = new Blob([audioBytes], { type: audioOptions.mode === 'upload' ? audioOptions.mimeType : 'audio/wav' });
                const audioUrl = URL.createObjectURL(audioBlob);
                return { audioUrl, audioBase64 };
            }
        } catch (err) {
            console.error("Audio generation failed:", err);
            onProgress("Audio generation failed. Continuing without audio.");
        }
        return { audioUrl: null, audioBase64: null };
    })();


    const validAspectRatio = aspectRatio === '16:9' || aspectRatio === '9:16' ? aspectRatio : '16:9';
    
    const characterInstructions = characters.length > 0
        ? `The following characters MUST be animated according to their descriptions:\n${characters.map(c => `- **${c.name}**: ${c.description}`).join('\n')}`
        : "No specific characters defined. Animate the scene elements as appropriate.";

    const cameraInstruction = CAMERA_MOVEMENT_PROMPTS[cameraMovement] || CAMERA_MOVEMENT_PROMPTS['Static Hold'];

    let audioInstruction = 'No specific audio instructions.';
    if (audioOptions?.mode === 'upload' && audioOptions.assignment) {
        if (audioOptions.assignment.type === 'character') {
            audioInstruction = `**Audio Lip-Sync:** Animate the mouth of the character named **${audioOptions.assignment.characterName}** to be in sync with the provided audio. They are speaking or singing.`;
        } else {
            audioInstruction = `**Audio Background:** The provided audio is background sound or music. Do not lip-sync any characters to it.`;
        }
    }


    const finalPrompt = `You are an expert animator creating a short video from a static image.

### Input Image Analysis
- **Scene:** ${scene.prompt}
- **Art Style:** ${imageStyle}

### Animation Instructions
1.  **Action:** ${script || "Bring the scene to life with subtle, natural motion. The animation should be smooth and high-quality."}
2.  **Characters:**
${characterInstructions}
3.  **Camera Movement:** ${cameraInstruction}
4.  **Audio Instructions:** ${audioInstruction}

### Critical Rule
Animate the specified **Action** and **Camera Movement** while maintaining perfect visual consistency with the input image's style, characters, and setting. The camera movement should be the primary motion; characters and scene elements should remain static relative to each other unless their movement is part of the **Action**.`;

    onProgress("Starting video generation...");

    try {
        let operation: any = await withRetry(() => ai.models.generateVideos({
            model: videoModel,
            prompt: finalPrompt,
            image: {
                imageBytes: scene.src!,
                mimeType: 'image/png',
            },
            config: {
                numberOfVideos: 1,
                resolution: videoResolution,
                aspectRatio: validAspectRatio as '16:9' | '9:16',
            },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
        }), (msg) => onProgress(`Initial request: ${msg}`));

        onProgress("Video generation in progress...");

        while (!operation.done) {
            await delay(10000); 
            onProgress("Checking video status...");
            operation = await withRetry(() => ai.operations.getVideosOperation({ operation: operation }), (msg) => onProgress(`Polling: ${msg}`));
        }

        onProgress("Finalizing video...");
        
        if (operation.error) {
            console.error("Video generation operation failed with an error:", operation.error);
            const errorPayload = { error: operation.error };
            throw new Error(JSON.stringify(errorPayload));
        }

        const videoObject = operation.response?.generatedVideos?.[0]?.video;
        const downloadLink = videoObject?.uri;
        if (!downloadLink || !videoObject) {
            console.warn("Video generation finished without a video object. Full operation object:", JSON.stringify(operation, null, 2));
            throw new Error("Video generation completed, but no video was returned. This may be due to the prompt being blocked by a safety filter. Please try a different prompt.");
        }

        const downloadUrl = new URL(downloadLink);
        downloadUrl.searchParams.set('key', process.env.API_KEY!);
        const videoResponse = await fetch(downloadUrl.toString());
        if (!videoResponse.ok) {
            const errorBody = await videoResponse.text();
            console.error(`Failed to download video. Status: ${videoResponse.status}. Body:`, errorBody);
            let userMessage = `Failed to download the generated video. Status: ${videoResponse.statusText} (${videoResponse.status}).`;
            if (videoResponse.status === 403) {
                userMessage += " This may be due to an API key permission issue.";
            } else if (videoResponse.status === 404) {
                userMessage += " The video link may have expired or is invalid.";
            }
            throw new Error(userMessage);
        }

        const videoBlob = await videoResponse.blob();
        const videoUrl = URL.createObjectURL(videoBlob);
        
        const { audioUrl, audioBase64 } = await audioDataPromise;

        return { videoUrl, audioUrl, audioBase64, videoObject };
    } catch (error) {
        throw error;
    }
}
