
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { generateImageSet, generateVideoFromScene, StoryboardScene, generatePromptFromAudio, generateCharacterDescription, AudioOptions, generateSingleImage, Character, generateCameraAnglesFromImage, editImage, EditImageParams } from './services/geminiService';
import { fileToBase64, base64ToBytes } from './utils/fileUtils';
import { parseErrorMessage } from './utils/errorUtils';
import { SparklesIcon, LoaderIcon, DownloadIcon, VideoIcon, PlusCircleIcon, ChevronLeftIcon, ChevronRightIcon, UserPlusIcon, XCircleIcon, RefreshIcon, TrashIcon, XIcon, BookmarkIcon, HistoryIcon, UploadIcon, CameraIcon, UndoIcon, ChevronDownIcon, ChevronUpIcon } from './components/Icons';

type AppStatus = {
  status: 'idle' | 'loading' | 'error';
  error: string | null;
};

type AppStoryboardScene = StoryboardScene & { 
    isRegenerating?: boolean;
    isGeneratingAngles?: boolean;
    isEditing?: boolean;
    previousSrc?: string | null;
};

type GenerationItem = {
  id: number;
  prompt: string;
  imageSet: AppStoryboardScene[];
  videoStates: VideoState[];
  aspectRatio: string;
  imageStyle: string;
  genre: string;
  characters: Character[];
  imageModel: string;
};

type SavedItem = {
  id: string; // Unique ID, e.g., `${generationId}-${sceneIndex}`
  scene: StoryboardScene;
  videoState: VideoState;
  originalPrompt: string;
  aspectRatio: string;
  imageStyle: string;
  genre: string;
  characters: Character[];
  imageModel: string;
  expiresAt: number; // UTC timestamp
};

type UploadedItem = {
    id: string;
    generationItem: Omit<GenerationItem, 'id' | 'videoStates'> & { imageSet: AppStoryboardScene[] };
    videoStates: VideoState[];
    mimeType: string;
    detectedCharacters: string[];
    addedCharacterIds?: number[];
};

type AudioAssignment = {
  file: File;
  transcription: string;
  detectedCharacters: Character[];
  assignment: { type: 'character'; characterId: number } | { type: 'background' } | null;
};


type VideoClip = {
  videoUrl: string | null;
  audioUrl: string | null;
  videoObject: any;
  audioBase64: string | null;
};

type VideoState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  clips: VideoClip[];
  currentClipIndex: number;
  error: string | null;
  loadingMessage: string;
  showScriptInput: boolean;
  scriptPrompt: string;
  voiceoverMode: 'tts' | 'upload';
  voiceoverFile: File | null;
  speaker: string; // Note: This is now legacy, kept for state structure but multi-speaker is handled dynamically
  cameraMovement: string;
};


// Use AI Studio's synchronized storage if available, with a fallback to local storage.
// This enables saved items to be accessed across different devices.
const saveItems = async (items: SavedItem[]) => {
  const saveData = async (dataToSave: SavedItem[]) => {
    const data = JSON.stringify(dataToSave);
    const storage = (window as any).aistudio?.storage;
    if (storage && typeof storage.setItem === 'function') {
      await storage.setItem('creativeSuiteSavedItems', data);
    } else {
      localStorage.setItem('creativeSuiteSavedItems', data);
    }
  };

  let currentItems = [...items];
  // Attempt to save, and if a quota error occurs, remove the oldest item and retry.
  while (currentItems.length > 0) {
    try {
      await saveData(currentItems);
      return; // Success
    } catch (error: any) {
      if (error.name === 'QuotaExceededError' || (error.message && error.message.toLowerCase().includes('quota'))) {
        console.warn('Storage quota exceeded. Removing the oldest item and retrying...');
        // Sort by expiration to find the "oldest" (soonest to expire)
        currentItems.sort((a, b) => a.expiresAt - b.expiresAt);
        currentItems.shift(); // Remove the oldest item
      } else {
        console.error("Failed to save items:", error);
        return; // Don't retry for other errors
      }
    }
  }
  if (items.length > 0) {
      console.error("Failed to save items: Could not save even a single item due to storage quota.");
  }
};

const loadItems = async (): Promise<SavedItem[]> => {
  try {
    let storedItems: string | null = null;
    // FIX: Safely access window.aistudio.storage which may not be defined in the global AIStudio type.
    const storage = (window as any).aistudio?.storage;
    if (storage && typeof storage.getItem === 'function') {
      storedItems = await storage.getItem('creativeSuiteSavedItems');
    } else {
      // FIX: localStorage.getItem takes only one argument, the key. The second argument 'data' was incorrect and not defined.
      storedItems = localStorage.getItem('creativeSuiteSavedItems');
    }

    if (storedItems) {
      const items: SavedItem[] = JSON.parse(storedItems);
      const now = Date.now();
      const validItems = items.filter(item => item.expiresAt > now);
      if (validItems.length !== items.length) {
        await saveItems(validItems); // Clean up expired items
      }
      return validItems;
    }
  } catch (error) {
    console.error("Failed to load items:", error);
  }
  return [];
};

const ASPECT_RATIOS = ["16:9", "9:16"];
const IMAGE_STYLES = [
    "Nigerian Cartoon",
    "Cartoon (Big Head)",
    "Illustration",
    "3D Render",
    "Realistic Photo",
    "Oil Painting",
    "Pixel Art",
    "2D Flat",
    "Anime",
    "Clip Art",
    "Video Game",
    "Pastel Sketch",
    "Dark Fantasy",
    "Cyberpunk",
    "Steampunk",
    "Watercolor",
    "Art Nouveau",
];
const GENRES = [
    "General", "Fiction", "Non-fiction", "Science Fiction", "Fantasy", "Mystery", "Horror", "Comedy",
];

const CAMERA_MOVEMENTS = [
    { name: 'Static Hold', label: 'Static', description: 'Keeps the camera fixed for calm, stable, documentary-style framing.', emoji: '📷' },
    { name: 'Drone Rise Tilt-Up', label: 'Drone Rise', description: 'The camera ascends smoothly while tilting upward — perfect for dramatic reveals or establishing shots.', emoji: '🚁' },
    { name: 'Dolly Back (Pull-Out)', label: 'Dolly Back', description: 'The camera moves backward from the subject, revealing more of the environment.', emoji: '🚶‍♂️' },
    { name: 'Pan Left', label: 'Pan Left', description: 'Smooth lateral movement to the left — ideal for following motion or creating visual tension.', emoji: '⬅️' },
    { name: 'Pan Right', label: 'Pan Right', description: 'Smooth lateral movement to the right — balances or contrasts with subject motion.', emoji: '➡️' },
    { name: 'Orbit Around Subject', label: 'Orbit', description: 'The camera circles around the character for a dynamic cinematic feel.', emoji: '🔄' },
    { name: 'Crane Down', label: 'Crane Down', description: 'Moves downward gracefully, transitioning between heights or emotional beats.', emoji: '⬇️' },
    { name: 'Crane Up', label: 'Crane Up', description: 'Moves upward for a powerful lift or ending shot.', emoji: '⬆️' },
    { name: 'Tracking Shot (Follow)', label: 'Track', description: 'The camera follows the subject in motion, maintaining framing consistency.', emoji: '🏃‍♂️' },
    { name: 'Zoom In (Focus In)', label: 'Zoom In', description: 'Slowly closes in on the subject — great for emphasis or emotion.', emoji: '➕' },
    { name: 'Zoom Out (Reveal)', label: 'Zoom Out', description: 'Pulls out to reveal the setting or a larger perspective.', emoji: '➖' },
];

const CollapsibleSection: React.FC<{ title: string; children: React.ReactNode; defaultOpen?: boolean }> = ({ title, children, defaultOpen = false }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="border border-gray-700/50 rounded-lg bg-gray-500/5">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex justify-between items-center p-3 text-left"
            >
                <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">{title}</h3>
                {isOpen ? <ChevronUpIcon className="w-5 h-5 text-gray-400" /> : <ChevronDownIcon className="w-5 h-5 text-gray-400" />}
            </button>
            {isOpen && (
                <div className="p-4 border-t border-gray-700/50">
                    {children}
                </div>
            )}
        </div>
    );
};

const SpeakerSelector: React.FC<{ characters: Character[]; scriptPrompt: string }> = ({ characters, scriptPrompt }) => {
    const allPossibleSpeakers = useMemo(() => ['Narrator', ...characters.map(c => c.name).filter(Boolean)], [characters]);

    const activeSpeakers = useMemo(() => {
        const lines = scriptPrompt.split('\n');
        const speakers = new Set<string>();
        const knownSpeakerNames = new Set(allPossibleSpeakers.map(s => s.toLowerCase()));

        lines.forEach(line => {
            const match = line.match(/^([\w\s]+):/);
            if (match && match[1]) {
                const speakerName = match[1].trim();
                if (knownSpeakerNames.has(speakerName.toLowerCase())) {
                    const originalCasingName = allPossibleSpeakers.find(s => s.toLowerCase() === speakerName.toLowerCase());
                    if(originalCasingName) {
                        speakers.add(originalCasingName);
                    }
                }
            }
        });

        if (speakers.size === 0 && scriptPrompt.trim().length > 0) {
            speakers.add('Narrator');
        }

        return speakers;
    }, [scriptPrompt, allPossibleSpeakers]);

    return (
        <div className="space-y-2">
            <h5 className="font-semibold text-gray-100 text-sm">Detected Speakers</h5>
            <div className="flex flex-wrap gap-2">
                {allPossibleSpeakers.map(name => (
                    <div
                        key={name}
                        title={activeSpeakers.has(name) ? `${name} is speaking` : `${name} is not currently speaking`}
                        className={`px-3 py-1 text-xs font-semibold rounded-full transition-all text-center border ${
                            activeSpeakers.has(name)
                                ? 'bg-green-500 text-white border-green-400 shadow-md scale-105'
                                : 'bg-gray-700 text-gray-300 border-gray-600'
                        }`}
                    >
                        {name}
                    </div>
                ))}
            </div>
            <p className="text-xs text-gray-500 pt-1">To use multiple speakers, format your script like this:<br/>CharacterOne: Hello there!<br/>CharacterTwo: Hi!</p>
        </div>
    );
};


const CameraMovementSelector: React.FC<{
    selectedMovement: string;
    onSelect: (movement: string) => void;
}> = ({ selectedMovement, onSelect }) => {
    const [isOpen, setIsOpen] = useState(true);

    return (
        <div className="space-y-2">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex justify-between items-center p-2 bg-gray-800/50 rounded-md hover:bg-gray-700/50"
            >
                <h5 className="font-semibold text-gray-100 text-sm">Cinematic Camera Movement</h5>
                {isOpen ? <ChevronUpIcon className="w-5 h-5 text-gray-400" /> : <ChevronDownIcon className="w-5 h-5 text-gray-400" />}
            </button>
            {isOpen && (
                <div className="grid grid-cols-4 gap-2 pt-2">
                    {CAMERA_MOVEMENTS.map(({ name, label, description, emoji }) => (
                        <button
                            key={name}
                            type="button"
                            title={description}
                            onClick={() => onSelect(name)}
                            className={`p-1.5 text-xs font-semibold rounded-lg transition-all text-center border-2 flex flex-col items-center justify-center aspect-square ${
                                selectedMovement === name
                                    ? 'bg-indigo-500 text-white border-indigo-400 shadow-lg scale-105'
                                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600/80 hover:border-gray-500 border-gray-600'
                            }`}
                        >
                            <span className="block text-xl mb-0.5" role="img" aria-label={name}>{emoji}</span>
                            <span className="leading-tight text-[10px]">{label}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

const GenerationResultItem: React.FC<{
    generationItem: GenerationItem;
    savedItems: SavedItem[];
    onToggleSave: (generationItem: GenerationItem, sceneIndex: number) => void;
    onGenerateVideoToggle: (index: number) => void;
    onConfirmGenerateVideo: (scene: StoryboardScene, index: number) => void;
    onExtendFromLastFrame: (sceneIndex: number) => void;
    onVideoStateChange: (index: number, changes: Partial<VideoState>) => void;
    onDeleteVideo: (index: number) => void;
    onDeleteClip: (sceneIndex: number, clipIndex: number) => void;
    onRegenerateImage: (index: number) => void;
    onEditImage: (sceneIndex: number, editPrompt: string) => void;
    onUndoEdit: (sceneIndex: number) => void;
    onHydrateClips: (sceneIndex: number, clips: VideoClip[]) => void;
    onGenerateCameraAngles: (sceneIndex: number) => void;
    onDeleteScene: (sceneIndex: number) => void;
    onDelete: () => void;
}> = (props) => {
    const { generationItem, onDelete, savedItems, onToggleSave, onDeleteScene } = props;
    
    const initialSceneIndex = useMemo(() => {
        const firstRootIndex = generationItem.imageSet.findIndex(s => s.isCameraAngleFor === undefined);
        return firstRootIndex >= 0 ? firstRootIndex : 0;
    }, [generationItem.imageSet]);

    const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(initialSceneIndex);
    const [isHydrating, setIsHydrating] = useState(false);
    const [showEdit, setShowEdit] = useState(false);
    const [editPrompt, setEditPrompt] = useState('');

    useEffect(() => {
        if (selectedSceneIndex >= generationItem.imageSet.length) {
            setSelectedSceneIndex(initialSceneIndex);
        }
    }, [generationItem.imageSet, selectedSceneIndex, initialSceneIndex]);

    const handleSelectScene = (index: number) => {
        if (!generationItem.imageSet[index].isRegenerating) {
            setSelectedSceneIndex(index);
        }
    };
    
    const scene = generationItem.imageSet[selectedSceneIndex];
    const videoState = generationItem.videoStates[selectedSceneIndex];
    const { aspectRatio, imageStyle, characters } = generationItem;

     useEffect(() => {
        const hydrateClips = async () => {
            if (!videoState) return;
            const clipsToHydrate = videoState.clips.filter(c => (!c.videoUrl && c.videoObject) || (!c.audioUrl && c.audioBase64));
            if (clipsToHydrate.length === 0) return;

            setIsHydrating(true);
            try {
                const hydratedClips = await Promise.all(videoState.clips.map(async (clip) => {
                    let newVideoUrl = clip.videoUrl;
                    let newAudioUrl = clip.audioUrl;
                    if (!newVideoUrl && clip.videoObject?.uri) {
                        const downloadLink = clip.videoObject.uri;
                        const downloadUrl = new URL(downloadLink);
                        downloadUrl.searchParams.set('key', process.env.API_KEY!);
                        const response = await fetch(downloadUrl.toString());
                        if (!response.ok) throw new Error(`Failed to load video. Status: ${response.statusText}`);
                        const blob = await response.blob();
                        newVideoUrl = URL.createObjectURL(blob);
                    }
                    if (!newAudioUrl && clip.audioBase64) {
                        const bytes = base64ToBytes(clip.audioBase64);
                        const blob = new Blob([bytes], { type: 'audio/wav' });
                        newAudioUrl = URL.createObjectURL(blob);
                    }
                    return { ...clip, videoUrl: newVideoUrl, audioUrl: newAudioUrl };
                }));
                props.onHydrateClips(selectedSceneIndex, hydratedClips);
            } catch (error) {
                console.error("Failed to hydrate clips:", error);
                props.onVideoStateChange(selectedSceneIndex, { status: 'error', error: 'Failed to load media from history.' });
            } finally {
                setIsHydrating(false);
            }
        };

        if (videoState?.status === 'success') {
            hydrateClips();
        }
    }, [videoState, selectedSceneIndex, props]);

    const handleDownloadImage = (base64: string) => {
        const characterNames = generationItem.characters.map(c => c.name).filter(Boolean);
        const promptPrefix = scene.prompt.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '_');
        let fileName = `scene_${promptPrefix}`;

        if (characterNames.length > 0) {
            fileName = `${fileName}--chars--[${characterNames.join(',')}].png`;
        } else {
            fileName = `${fileName}.png`;
        }
        
        const link = document.createElement('a');
        link.href = `data:image/png;base64,${base64}`;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const currentClip = videoState?.clips[videoState.currentClipIndex];
    const imageFailed = !scene?.src;
    const isVideoAspectRatioSupported = aspectRatio === '16:9' || aspectRatio === '9:16';
    const isActionInProgress = scene?.isRegenerating || scene?.isEditing || scene?.isGeneratingAngles;

    const renderContent = () => {
        if (!scene || !videoState) return null;
        if (isHydrating) return <div className="flex flex-col items-center justify-center text-center"><LoaderIcon className="w-10 h-10 animate-spin text-gray-400" /><p className="mt-2 text-sm text-gray-300">Loading Media...</p></div>;
        
        switch (videoState.status) {
            case 'loading': 
                return <div className="flex flex-col items-center justify-center text-center"><LoaderIcon className="w-10 h-10 animate-spin text-green-400" /><p className="mt-4 text-sm text-gray-200">{videoState.loadingMessage}</p></div>;
            case 'error': 
                return (
                    <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-start justify-between gap-4 w-full max-w-md">
                        <div className="flex-grow">
                            <h4 className="font-bold text-red-400">Video Generation Failed</h4>
                            <p className="text-sm text-red-300 mt-1">{videoState.error}</p>
                        </div>
                        <button onClick={() => props.onDeleteVideo(selectedSceneIndex)} className="text-rose-400 hover:text-rose-200 shrink-0" title="Reset Video Attempt">
                            <XIcon className="w-5 h-5" />
                        </button>
                    </div>
                );
            case 'success':
                if (!currentClip?.videoUrl) return <div className="flex flex-col items-center justify-center"><LoaderIcon className="w-10 h-10 animate-spin text-gray-400" /><p className="mt-2 text-sm">Loading video...</p></div>;
                return (
                    <div className="w-full h-full flex flex-col justify-center items-center gap-2 relative group">
                        <video key={currentClip.videoUrl} src={currentClip.videoUrl} controls autoPlay muted loop className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-2xl" />
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-2.5 py-1 rounded-full flex items-center gap-2">
                            {videoState.clips.length > 1 && <span>Clip {videoState.currentClipIndex + 1} of {videoState.clips.length}</span>}
                            <button onClick={() => { if (window.confirm(`Are you sure you want to delete Clip ${videoState.currentClipIndex + 1}?`)) props.onDeleteClip(selectedSceneIndex, videoState.currentClipIndex); }} className="text-rose-400 hover:text-rose-200" title={`Delete Clip ${videoState.currentClipIndex + 1}`}>
                                <TrashIcon className="w-4 h-4" />
                            </button>
                        </div>
                        {videoState.clips.length > 1 && (
                            <>
                                <button onClick={() => props.onVideoStateChange(selectedSceneIndex, { currentClipIndex: videoState.currentClipIndex - 1 })} disabled={videoState.currentClipIndex === 0} className="absolute left-3 top-1/2 -translate-y-1/2 bg-black/50 text-white p-1.5 rounded-full hover:bg-black/80 disabled:opacity-30 transition-opacity"><ChevronLeftIcon className="w-6 h-6" /></button>
                                <button onClick={() => props.onVideoStateChange(selectedSceneIndex, { currentClipIndex: videoState.currentClipIndex + 1 })} disabled={videoState.currentClipIndex === videoState.clips.length - 1} className="absolute right-3 top-1/2 -translate-y-1/2 bg-black/50 text-white p-1.5 rounded-full hover:bg-black/80 disabled:opacity-30 transition-opacity"><ChevronRightIcon className="w-6 h-6" /></button>
                            </>
                        )}
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/70 p-2 rounded-full backdrop-blur-sm z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                             <a href={currentClip.videoUrl ?? '#'} download={`generated-video-clip-${videoState.currentClipIndex + 1}.mp4`} className={`p-2 rounded-full transition-colors ${!currentClip.videoUrl ? 'opacity-50 cursor-not-allowed' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`} title="Download Video Clip">
                                <DownloadIcon className="w-5 h-5" />
                            </a>
                            <button onClick={() => props.onDeleteVideo(selectedSceneIndex)} className="p-2 text-rose-300 bg-rose-800/50 rounded-full hover:bg-rose-700/80 transition-colors" title="Delete Video (Revert to Image)">
                                <TrashIcon className="w-5 h-5" />
                            </button>
                        </div>
                        {currentClip.audioUrl && <audio src={currentClip.audioUrl} controls className="w-full max-w-sm mt-2" />}
                    </div>
                );
            default:
                const isSaved = savedItems.some(item => item.id === `${generationItem.id}-${selectedSceneIndex}`);
                return (
                    <div className="relative w-full h-full flex items-center justify-center group">
                        <img src={`data:image/png;base64,${scene.src}`} alt={`Generated scene ${selectedSceneIndex + 1}`} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/70 p-2 rounded-full backdrop-blur-sm z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                            <button onClick={() => scene.src && handleDownloadImage(scene.src)} disabled={imageFailed || isActionInProgress} className="p-2 text-gray-300 bg-gray-700 rounded-full hover:bg-gray-600 transition-colors disabled:opacity-50" title="Download Image">
                                <DownloadIcon className="w-5 h-5" />
                            </button>
                            <button onClick={() => onToggleSave(generationItem, selectedSceneIndex)} disabled={imageFailed || isActionInProgress} className={`p-2 rounded-full transition-colors disabled:opacity-50 ${isSaved ? 'bg-amber-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-amber-500'}`} title={isSaved ? 'Unsave' : 'Save'}>
                                <BookmarkIcon className="w-5 h-5" solid={isSaved} />
                            </button>
                        </div>
                    </div>
                );
        }
    };

    const SceneThumbnail: React.FC<{ scene: AppStoryboardScene, index: number, isChild?: boolean, isSelected: boolean }> = ({ scene, index = 0, isChild = false, isSelected }) => {
        const isSaved = savedItems.some(item => item.id === `${generationItem.id}-${index}`);
        const aspectRatioClass = {"1:1": "aspect-square", "16:9": "aspect-video", "9:16": "aspect-[9/16]"}[generationItem.aspectRatio] ?? "aspect-square";

        return (
            <div
                onClick={() => handleSelectScene(index)}
                className={`${aspectRatioClass} ${isChild ? 'w-full' : ''} relative bg-gray-900/50 rounded-lg overflow-hidden group border-2 ${isSelected ? 'border-indigo-500 ring-2 ring-indigo-500 ring-offset-2 ring-offset-gray-800' : 'border-gray-700'} transition-all duration-300 hover:border-indigo-500`}
            >
                {scene.src && <img src={`data:image/png;base64,${scene.src}`} alt={`Scene ${index + 1}`} className="w-full h-full object-cover" />}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center p-1 cursor-pointer z-10"><p className="text-white font-bold text-xs">Select</p></div>

                {!isChild && (
                    <div className="absolute top-1.5 left-1.5 bg-black/60 text-white text-xs font-bold px-2 py-0.5 rounded-full z-20">
                        {generationItem.imageSet.filter(s => s.isCameraAngleFor === undefined).findIndex(s => s.prompt === scene.prompt) + 1}
                    </div>
                )}
                
                <div className="absolute top-1 right-1 flex gap-1 z-20">
                     <button onClick={(e) => { e.stopPropagation(); onToggleSave(generationItem, index); }} className={`p-1 rounded-full transition-all duration-200 ${isSaved ? 'bg-amber-500 text-white' : 'bg-black/50 text-gray-300 opacity-0 group-hover:opacity-100 hover:bg-amber-500 hover:text-white'}`} disabled={!scene.src || scene.isRegenerating || scene.isGeneratingAngles}>
                       <BookmarkIcon className="w-4 h-4" solid={isSaved} />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onDeleteScene(index); }} className="p-1 rounded-full bg-black/50 text-gray-300 opacity-0 group-hover:opacity-100 hover:bg-rose-600 hover:text-white transition-all duration-200" title="Delete Scene">
                        <TrashIcon className="w-4 h-4" />
                    </button>
                </div>
                
                {scene.src && !scene.isRegenerating && !scene.isCameraAngleFor && (
                    <button onClick={(e) => { e.stopPropagation(); props.onGenerateCameraAngles(index); }} disabled={scene.isGeneratingAngles} className="absolute bottom-1 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 px-2 py-0.5 bg-black/70 text-white text-xs font-semibold rounded-full transition-all duration-200 opacity-0 group-hover:opacity-100 hover:bg-indigo-600 disabled:bg-gray-700 disabled:opacity-50">
                        {scene.isGeneratingAngles ? <LoaderIcon className="w-3 h-3 animate-spin" /> : <CameraIcon className="w-3 h-3" />}
                    </button>
                )}
                {(scene.isRegenerating || scene.isGeneratingAngles || scene.isEditing) && (
                    <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center text-center p-2">
                        <LoaderIcon className="w-6 h-6 text-blue-400 animate-spin mb-2" />
                        <p className="text-xs text-gray-300">{scene.isGeneratingAngles ? 'Generating...' : scene.isEditing ? 'Editing...' : 'Regenerating...'}</p>
                    </div>
                )}
            </div>
        );
    };

    const sceneTree = useMemo(() => {
        if (!generationItem.imageSet) return [];
        const roots: ({ scene: AppStoryboardScene, originalIndex: number, children: ({ scene: AppStoryboardScene, originalIndex: number })[] })[] = [];
        const childrenMap: { [key: number]: ({ scene: AppStoryboardScene, originalIndex: number })[] } = {};
        generationItem.imageSet.forEach((s, i) => s.isCameraAngleFor !== undefined ? (childrenMap[s.isCameraAngleFor] = [...(childrenMap[s.isCameraAngleFor] || []), { scene: s, originalIndex: i }]) : roots.push({ scene: s, originalIndex: i, children: [] }));
        roots.forEach(r => { r.children = (childrenMap[r.originalIndex] || []).sort((a,b) => a.originalIndex - b.originalIndex); });
        return roots;
    }, [generationItem.imageSet]);

    if (!scene || !videoState) {
        return (
            <div className="bg-gray-800/30 p-4 rounded-xl border border-gray-700/50 w-full relative">
                 <button onClick={onDelete} className="absolute top-4 right-4 text-gray-400 hover:text-white z-10"><XIcon className="w-6 h-6" /></button>
                <h2 className="text-xl font-bold tracking-tight text-indigo-400 mb-1">Generation Result</h2>
                <div className="text-center py-8 text-gray-400">No scenes to display.</div>
            </div>
        );
    }
    const showVideoControls = videoState.status !== 'idle' && videoState.status !== 'loading' && !videoState.showScriptInput;

    return (
        <div className="bg-gray-800/30 p-5 rounded-xl border border-gray-700/50 w-full relative">
            <div className="flex justify-between items-start mb-4">
                <div>
                    <h2 className="text-xl font-bold tracking-tight text-indigo-400 mb-1">Generation Result</h2>
                    <p className="text-sm text-gray-400 bg-black/20 p-3 rounded-md font-mono whitespace-pre-wrap break-words">"{generationItem.prompt}"</p>
                </div>
                <button onClick={onDelete} className=" text-gray-500 hover:text-white z-10"><XIcon className="w-6 h-6" /></button>
            </div>
            
            <div className="flex flex-col lg:flex-row gap-6">
                <div className="lg:w-2/3 bg-black/30 flex items-center justify-center p-4 rounded-lg min-h-[400px] relative group">
                    {isActionInProgress ? <div className="flex flex-col items-center justify-center text-center p-3"><LoaderIcon className="w-10 h-10 text-blue-400 animate-spin mb-2" /><p className="text-sm text-gray-300">{scene.isGeneratingAngles ? 'Generating Angles...' : scene.isEditing ? 'Applying Edits...' : 'Regenerating...'}</p></div>
                    : imageFailed ? <div className="w-full bg-red-900/20 rounded-lg border-2 border-dashed border-red-500/50 flex flex-col items-center justify-center p-4"><h4 className="font-bold text-red-400 mb-2">Image Failed</h4><p className="text-sm text-red-300 text-center mb-4">{scene.error}</p><button onClick={() => props.onRegenerateImage(selectedSceneIndex)} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500"><RefreshIcon className="w-4 h-4"/>Try Again</button></div>
                    : renderContent()}
                </div>
                <div className="lg:w-1/3 flex flex-col gap-4">
                    <div>
                        <p className="text-sm text-gray-400 font-semibold mb-2">Scenes & Angles</p>
                        <div className="grid grid-cols-3 gap-2 items-start">
                            {sceneTree.map((root) => (
                                <div key={root.originalIndex} className="flex flex-col gap-y-2">
                                    <SceneThumbnail scene={root.scene} index={root.originalIndex} isSelected={root.originalIndex === selectedSceneIndex} />
                                    {root.children.length > 0 && (
                                        <div className="pl-2 mt-1 space-y-2 border-l-2 border-indigo-700/50">
                                            {root.children.map(child => <SceneThumbnail key={child.originalIndex} scene={child.scene} index={child.originalIndex} isSelected={child.originalIndex === selectedSceneIndex} isChild />)}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-4 overflow-y-auto">
                        {characters && characters.filter(c => c.name).length > 0 && (
                            <div className="mb-2">
                                <p className="text-sm text-green-400 font-semibold uppercase">Characters in Scene</p>
                                <div className="text-sm text-gray-300 mt-1 bg-black/20 p-2 rounded-md flex flex-wrap gap-2">
                                    {characters.filter(c => c.name).map(char => <span key={char.id} className="bg-gray-700 px-2 py-1 rounded text-xs font-semibold">{char.name}</span>)}
                                </div>
                            </div>
                        )}
                        
                        {videoState.status === 'idle' && (
                            <>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => setShowEdit(!showEdit)} disabled={imageFailed || isActionInProgress} className={`inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold rounded-md transition-colors disabled:opacity-50 ${showEdit ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}><SparklesIcon className="w-4 h-4" /> Edit Image</button>
                                    <button onClick={() => props.onRegenerateImage(selectedSceneIndex)} disabled={isActionInProgress} className="inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold text-gray-300 bg-gray-700 rounded-md hover:bg-gray-600 disabled:opacity-50"><RefreshIcon className="w-4 h-4" /> Regenerate</button>
                                </div>
                            </>
                        )}

                        {showEdit && !imageFailed && videoState.status === 'idle' && (
                            <div className="space-y-3 mt-4 bg-gray-900/30 p-3 rounded-lg border border-purple-700/50">
                                <h4 className="font-semibold text-purple-300">Edit Image</h4>
                                <textarea className="w-full bg-gray-800 border border-gray-600 rounded-md text-gray-300 text-sm p-2 focus:ring-1 focus:ring-purple-500" placeholder="e.g., add a hat" rows={3} value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} disabled={isActionInProgress} />
                                <div className="flex items-center gap-2">
                                    <button onClick={() => { props.onEditImage(selectedSceneIndex, editPrompt); setShowEdit(false); }} disabled={!editPrompt || isActionInProgress} className="flex-grow bg-purple-600 text-white text-sm font-bold py-2 rounded-md hover:bg-purple-500 disabled:opacity-50">{isActionInProgress ? 'Applying...' : 'Apply Edit'}</button>
                                    {scene.previousSrc && !isActionInProgress && (
                                        <button onClick={() => props.onUndoEdit(selectedSceneIndex)} className="shrink-0 p-2 bg-gray-700 text-gray-300 rounded-md hover:bg-gray-600" title="Undo Last Edit"><UndoIcon className="w-5 h-5" /></button>
                                    )}
                                </div>
                            </div>
                        )}

                        {!imageFailed && !showVideoControls && !videoState.showScriptInput && (
                            <div className="text-center mt-4">
                                <button onClick={() => props.onGenerateVideoToggle(selectedSceneIndex)} disabled={!isVideoAspectRatioSupported || isActionInProgress} className="inline-flex items-center gap-2 px-4 py-2 font-semibold text-white bg-green-600 rounded-md hover:bg-green-500 text-sm disabled:opacity-50"><VideoIcon className="w-5 h-5" /> Generate Video</button>
                                {!isVideoAspectRatioSupported && <p className="text-xs text-amber-400 mt-2">Video is only for 16:9 and 9:16.</p>}
                            </div>
                        )}

                        {videoState.showScriptInput && videoState.status !== 'loading' && (
                            <div className="space-y-4 mt-4 bg-gray-900/50 p-3 rounded-lg border border-gray-700">
                                <h4 className="font-semibold text-white">Create Video</h4>
                                <div className="flex border-b border-gray-700"><button onClick={() => props.onVideoStateChange(selectedSceneIndex, { voiceoverMode: 'tts'})} className={`flex-1 text-sm py-1.5 rounded-t-md ${videoState.voiceoverMode === 'tts' ? 'bg-gray-700 font-semibold' : 'bg-transparent text-gray-400'}`}>Text-to-Speech</button><button onClick={() => props.onVideoStateChange(selectedSceneIndex, { voiceoverMode: 'upload'})} className={`flex-1 text-sm py-1.5 rounded-t-md ${videoState.voiceoverMode === 'upload' ? 'bg-gray-700 font-semibold' : 'bg-transparent text-gray-400'}`}>Upload Audio</button></div>
                                <div className='p-1'>
                                {videoState.voiceoverMode === 'tts' ? (
                                    <div className="space-y-3">
                                        <SpeakerSelector characters={characters} scriptPrompt={videoState.scriptPrompt} />
                                        <textarea className="w-full bg-gray-800 border border-gray-600 rounded-md text-gray-300 text-sm p-2 focus:ring-1 focus:ring-green-500" placeholder={imageStyle === 'Nigerian Cartoon' ? "Write dialogue (AI will speak in Pidgin)..." : "Write dialogue or narration..."} rows={4} value={videoState.scriptPrompt} onChange={(e) => props.onVideoStateChange(selectedSceneIndex, { scriptPrompt: e.target.value })} />
                                    </div>
                                ) : (
                                     <div className="space-y-2"><label className="w-full text-center text-sm p-3 block bg-gray-800 border-2 border-dashed border-gray-600 rounded-md cursor-pointer hover:border-green-500">{videoState.voiceoverFile ? videoState.voiceoverFile.name : 'Choose audio file...'}<input type="file" accept="audio/*" className="hidden" onChange={(e) => props.onVideoStateChange(selectedSceneIndex, { voiceoverFile: e.target.files?.[0] || null })} /></label></div>
                                )}
                                </div>
                                <CameraMovementSelector selectedMovement={videoState.cameraMovement} onSelect={(movement) => props.onVideoStateChange(selectedSceneIndex, { cameraMovement: movement })}/>
                                <button onClick={() => props.onConfirmGenerateVideo(scene, selectedSceneIndex)} className="w-full bg-green-600 text-white text-sm font-bold py-2 rounded-md hover:bg-green-500">Start Generation</button>
                            </div>
                        )}
                        
                        {showVideoControls && (
                            <div className='space-y-3 mt-4'>
                                {videoState.status === 'success' && (
                                  <button onClick={() => props.onExtendFromLastFrame(selectedSceneIndex)} className="inline-flex w-full justify-center items-center gap-2 px-3 py-2 text-sm font-semibold text-teal-300 bg-teal-800/50 rounded-md hover:bg-teal-700"><PlusCircleIcon className="w-4 h-4" /> Create from Last Frame</button>
                                )}
                                <button onClick={() => props.onGenerateVideoToggle(selectedSceneIndex)} className="inline-flex w-full justify-center items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-300 bg-gray-700 rounded-md hover:bg-gray-600"><RefreshIcon className="w-4 h-4" /> Regenerate Video</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};


const UploadedItemManager: React.FC<{
    uploadedItem: UploadedItem;
    onDelete: () => void;
    savedItems: SavedItem[];
    onToggleSave: (sceneIndex: number) => void;
    onGenerateVideoToggle: (index: number) => void;
    onConfirmGenerateVideo: (scene: StoryboardScene, index: number) => void;
    onExtendFromLastFrame: (sceneIndex: number) => void;
    onVideoStateChange: (index: number, changes: Partial<VideoState>) => void;
    onDeleteVideo: (index: number) => void;
    onDeleteClip: (sceneIndex: number, clipIndex: number) => void;
    onEditImage: (sceneIndex: number, editPrompt: string) => void;
    onUndoEdit: (sceneIndex: number) => void;
    onHydrateClips: (sceneIndex: number, clips: VideoClip[]) => void;
    onGenerateCameraAngles: (sceneIndex: number) => void;
    onDeleteScene: (sceneIndex: number) => void;
}> = (props) => {
    const { uploadedItem, onDelete, savedItems, onToggleSave, onDeleteScene } = props;
    const [selectedSceneIndex, setSelectedSceneIndex] = useState<number>(0);
    const [isHydrating, setIsHydrating] = useState(false);
    const [showEdit, setShowEdit] = useState(false);
    const [editPrompt, setEditPrompt] = useState('');

    const handleSelectScene = (index: number) => {
        if (!uploadedItem.generationItem.imageSet[index].isRegenerating) {
            setSelectedSceneIndex(index);
        }
    };

    const scene = uploadedItem.generationItem.imageSet[selectedSceneIndex];
    const videoState = uploadedItem.videoStates[selectedSceneIndex];
    const generationItem = uploadedItem.generationItem;
    const { aspectRatio, imageStyle, characters } = generationItem;

    useEffect(() => {
        const hydrateClips = async () => {
            if (!videoState) return;
            const clipsToHydrate = videoState.clips.filter(c => (!c.videoUrl && c.videoObject) || (!c.audioUrl && c.audioBase64));
            if (clipsToHydrate.length === 0) return;

            setIsHydrating(true);
            try {
                const hydratedClips = await Promise.all(videoState.clips.map(async (clip) => {
                    let newVideoUrl = clip.videoUrl;
                    let newAudioUrl = clip.audioUrl;
                    if (!newVideoUrl && clip.videoObject?.uri) {
                        const downloadLink = clip.videoObject.uri;
                        const downloadUrl = new URL(downloadLink);
                        downloadUrl.searchParams.set('key', process.env.API_KEY!);
                        const response = await fetch(downloadUrl.toString());
                        if (!response.ok) throw new Error(`Failed to load video. Status: ${response.statusText}`);
                        const blob = await response.blob();
                        newVideoUrl = URL.createObjectURL(blob);
                    }
                    if (!newAudioUrl && clip.audioBase64) {
                        const bytes = base64ToBytes(clip.audioBase64);
                        const blob = new Blob([bytes], { type: 'audio/wav' });
                        newAudioUrl = URL.createObjectURL(blob);
                    }
                    return { ...clip, videoUrl: newVideoUrl, audioUrl: newAudioUrl };
                }));
                props.onHydrateClips(selectedSceneIndex, hydratedClips);
            } catch (error) {
                console.error("Failed to hydrate clips:", error);
                props.onVideoStateChange(selectedSceneIndex, { status: 'error', error: 'Failed to load media from history.' });
            } finally {
                setIsHydrating(false);
            }
        };

        if (videoState?.status === 'success') {
            hydrateClips();
        }
    }, [videoState, props, selectedSceneIndex]);

    const handleDownloadImage = (base64: string) => {
        const link = document.createElement('a');
        link.href = `data:image/png;base64,${base64}`;
        link.download = `uploaded_scene_${selectedSceneIndex}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const currentClip = videoState?.clips[videoState.currentClipIndex];
    const imageFailed = !scene.src;
    const isVideoAspectRatioSupported = aspectRatio === '16:9' || aspectRatio === '9:16';
    const isActionInProgress = scene.isEditing || scene.isGeneratingAngles;

    const renderContent = () => {
        if (!videoState) return null;
        if (isHydrating) return <div className="flex flex-col items-center justify-center"><LoaderIcon className="w-10 h-10 animate-spin text-gray-400" /><p className="mt-2 text-sm">Loading Media...</p></div>;
        switch (videoState.status) {
            case 'loading': return <div className="flex flex-col items-center justify-center text-center"><LoaderIcon className="w-10 h-10 animate-spin text-green-400" /><p className="mt-4 text-sm text-gray-200">{videoState.loadingMessage}</p></div>;
            case 'error': return (
                <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-lg flex items-start justify-between gap-4 w-full max-w-md">
                    <div className="flex-grow">
                        <h4 className="font-bold text-red-400">Video Generation Failed</h4>
                        <p className="text-sm text-red-300 mt-1">{videoState.error}</p>
                    </div>
                    <button onClick={() => props.onDeleteVideo(selectedSceneIndex)} className="text-rose-400 hover:text-rose-200 shrink-0" title="Reset Video Attempt">
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>
            );
            case 'success':
                if (!currentClip?.videoUrl) return <div className="flex flex-col items-center justify-center"><LoaderIcon className="w-10 h-10 animate-spin text-gray-400" /><p className="mt-2 text-sm">Loading video...</p></div>;
                return (
                    <div className="w-full h-full flex flex-col justify-center items-center gap-2 relative group">
                        <video key={currentClip.videoUrl} src={currentClip.videoUrl} controls autoPlay muted loop className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-2xl" />
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-2.5 py-1 rounded-full flex items-center gap-2">
                            {videoState.clips.length > 1 && <span>Clip {videoState.currentClipIndex + 1} of {videoState.clips.length}</span>}
                            <button
                                onClick={() => {
                                    if (window.confirm(`Are you sure you want to delete Clip ${videoState.currentClipIndex + 1}? This action cannot be undone.`)) {
                                        props.onDeleteClip(selectedSceneIndex, videoState.currentClipIndex);
                                    }
                                }}
                                className="text-rose-400 hover:text-rose-200"
                                title={`Delete Clip ${videoState.currentClipIndex + 1}`}
                            >
                                <TrashIcon className="w-4 h-4" />
                            </button>
                        </div>
                        {videoState.clips.length > 1 && (
                            <>
                                <button onClick={() => props.onVideoStateChange(selectedSceneIndex, { currentClipIndex: videoState.currentClipIndex - 1 })} disabled={videoState.currentClipIndex === 0} className="absolute left-3 top-1/2 -translate-y-1/2 bg-black/50 text-white p-1.5 rounded-full hover:bg-black/80 disabled:opacity-30 transition-opacity"><ChevronLeftIcon className="w-6 h-6" /></button>
                                <button onClick={() => props.onVideoStateChange(selectedSceneIndex, { currentClipIndex: videoState.currentClipIndex + 1 })} disabled={videoState.currentClipIndex === videoState.clips.length - 1} className="absolute right-3 top-1/2 -translate-y-1/2 bg-black/50 text-white p-1.5 rounded-full hover:bg-black/80 disabled:opacity-30 transition-opacity"><ChevronRightIcon className="w-6 h-6" /></button>
                            </>
                        )}
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/70 p-2 rounded-full backdrop-blur-sm z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                             <a href={currentClip.videoUrl ?? '#'} download={`generated-video-clip-${videoState.currentClipIndex + 1}.mp4`} className={`p-2 rounded-full transition-colors ${!currentClip.videoUrl ? 'opacity-50 cursor-not-allowed' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`} title="Download Video Clip">
                                <DownloadIcon className="w-5 h-5" />
                            </a>
                            <button onClick={() => props.onDeleteVideo(selectedSceneIndex)} className="p-2 text-rose-300 bg-rose-800/50 rounded-full hover:bg-rose-700/80 transition-colors" title="Delete Video (Revert to Image)">
                                <TrashIcon className="w-5 h-5" />
                            </button>
                        </div>
                        {currentClip.audioUrl && <audio src={currentClip.audioUrl} controls className="w-full max-w-sm mt-2" />}
                    </div>
                );
            default:
                const isSaved = savedItems.some(item => item.id === `${uploadedItem.id}-${selectedSceneIndex}`);
                return (
                    <div className="relative w-full h-full flex items-center justify-center group">
                        <img src={`data:image/png;base64,${scene.src}`} alt={`Uploaded scene ${selectedSceneIndex + 1}`} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/70 p-2 rounded-full backdrop-blur-sm z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                            <button onClick={() => scene.src && handleDownloadImage(scene.src)} disabled={imageFailed || isActionInProgress} className="p-2 text-gray-300 bg-gray-700 rounded-full hover:bg-gray-600 transition-colors disabled:opacity-50" title="Download Image">
                                <DownloadIcon className="w-5 h-5" />
                            </button>
                            <button onClick={() => onToggleSave(selectedSceneIndex)} disabled={imageFailed || isActionInProgress} className={`p-2 rounded-full transition-colors disabled:opacity-50 ${isSaved ? 'bg-amber-500 text-white' : 'bg-gray-700 text-gray-300 hover:bg-amber-500'}`} title={isSaved ? 'Unsave' : 'Save'}>
                                <BookmarkIcon className="w-5 h-5" solid={isSaved} />
                            </button>
                        </div>
                    </div>
                );
        }
    };

    const SceneThumbnail: React.FC<{ scene: AppStoryboardScene, index: number, isChild?: boolean, isSelected: boolean }> = ({ scene, index, isChild = false, isSelected }) => {
        const aspectRatioClass = {"1:1": "aspect-square", "16:9": "aspect-video", "9:16": "aspect-[9/16]"}[generationItem.aspectRatio] ?? "aspect-square";
        return (
            <div onClick={() => handleSelectScene(index)} className={`${aspectRatioClass} ${isChild ? 'w-full' : ''} relative bg-gray-900/50 rounded-lg overflow-hidden group border-2 ${isSelected ? 'border-indigo-500 ring-2 ring-indigo-500 ring-offset-2 ring-offset-gray-800' : 'border-gray-700'} transition-all duration-300 hover:border-indigo-500`}>
                {scene.src && <img src={`data:image/png;base64,${scene.src}`} alt={`Scene ${index + 1}`} className="w-full h-full object-cover" />}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center p-1 cursor-pointer z-10"><p className="text-white font-bold text-xs">Select</p></div>
                 <div className="absolute top-1 right-1 flex gap-1 z-20">
                    <button onClick={(e) => { e.stopPropagation(); onDeleteScene(index); }} className="p-1 rounded-full bg-black/50 text-gray-300 opacity-0 group-hover:opacity-100 hover:bg-rose-600 hover:text-white transition-all duration-200" title="Delete Scene">
                        <TrashIcon className="w-4 h-4" />
                    </button>
                </div>
                {scene.src && !scene.isRegenerating && !scene.isCameraAngleFor && (
                    <button onClick={(e) => { e.stopPropagation(); props.onGenerateCameraAngles(index); }} disabled={scene.isGeneratingAngles} className="absolute bottom-1 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 px-2 py-0.5 bg-black/70 text-white text-xs font-semibold rounded-full transition-all duration-200 opacity-0 group-hover:opacity-100 hover:bg-indigo-600 disabled:bg-gray-700 disabled:opacity-50">
                        {scene.isGeneratingAngles ? <LoaderIcon className="w-3 h-3 animate-spin" /> : <CameraIcon className="w-3 h-3" />}
                    </button>
                )}
                {(scene.isRegenerating || scene.isGeneratingAngles || scene.isEditing) && (
                    <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center text-center p-2">
                        <LoaderIcon className="w-6 h-6 text-blue-400 animate-spin mb-2" />
                        <p className="text-xs text-gray-300">{scene.isGeneratingAngles ? 'Generating...' : scene.isEditing ? 'Editing...' : 'Regenerating...'}</p>
                    </div>
                )}
            </div>
        );
    };

    const sceneTree = useMemo(() => {
        const roots: ({ scene: AppStoryboardScene, originalIndex: number, children: ({ scene: AppStoryboardScene, originalIndex: number })[] })[] = [];
        const childrenMap: { [key: number]: { scene: AppStoryboardScene, originalIndex: number }[] } = {};
        generationItem.imageSet.forEach((scene, index) => {
            if (scene.isCameraAngleFor !== undefined) {
                if (!childrenMap[scene.isCameraAngleFor]) childrenMap[scene.isCameraAngleFor] = [];
                childrenMap[scene.isCameraAngleFor].push({ scene, originalIndex: index });
            } else {
                roots.push({ scene, originalIndex: index, children: [] });
            }
        });
        roots.forEach(root => { root.children = (childrenMap[root.originalIndex] || []).sort((a,b) => a.originalIndex - b.originalIndex); });
        return roots;
    }, [generationItem.imageSet]);

    const showVideoControls = videoState.status !== 'idle' && videoState.status !== 'loading' && !videoState.showScriptInput;

    return (
        <div className="bg-gray-800/30 p-5 rounded-xl border border-gray-700/50 w-full relative">
            <div className="flex justify-between items-start mb-4">
                 <div>
                    <h2 className="text-xl font-bold tracking-tight text-green-400 mb-1">Animate Custom Image</h2>
                    <p className="text-sm text-gray-400">Edit your image, generate camera angles, or create a video directly.</p>
                </div>
                <button onClick={onDelete} className="text-gray-500 hover:text-white z-10"><XIcon className="w-6 h-6" /></button>
            </div>
            <div className="flex flex-col lg:flex-row gap-6">
                <div className="lg:w-2/3 bg-black/30 flex items-center justify-center p-4 rounded-lg relative group min-h-[400px]">
                    {isActionInProgress ? <div className="flex flex-col items-center justify-center text-center p-3"><LoaderIcon className="w-10 h-10 text-blue-400 animate-spin mb-2" /><p className="text-sm text-gray-300">{scene.isGeneratingAngles ? 'Generating Angles...' : 'Applying Edits...'}</p></div> : renderContent()}
                </div>
                <div className="lg:w-1/3 flex flex-col gap-4">
                    <div>
                        <p className="text-sm text-gray-400 font-semibold mb-2">Image Variants</p>
                        <div className="grid grid-cols-3 gap-2 items-start">
                            {sceneTree.map((root) => (
                                <div key={root.originalIndex} className="flex flex-col gap-y-2">
                                    <SceneThumbnail scene={root.scene} index={root.originalIndex} isSelected={root.originalIndex === selectedSceneIndex} />
                                    {root.children.length > 0 && (
                                        <div className="pl-2 mt-1 space-y-2 border-l-2 border-indigo-700/50">
                                            {root.children.map(child => <SceneThumbnail key={child.originalIndex} scene={child.scene} index={child.originalIndex} isSelected={child.originalIndex === selectedSceneIndex} isChild />)}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-4 overflow-y-auto">
                        {uploadedItem.detectedCharacters.length > 0 && (
                            <div className="mb-2">
                                <p className="text-sm text-green-400 font-semibold uppercase">Detected Characters from Filename</p>
                                <div className="text-sm text-gray-300 mt-1 bg-black/20 p-2 rounded-md flex flex-wrap gap-2">
                                    {uploadedItem.detectedCharacters.map(name => <span key={name} className="bg-gray-700 px-2 py-1 rounded text-xs font-semibold">{name}</span>)}
                                </div>
                            </div>
                        )}
                         
                        {videoState.status === 'idle' && (
                             <button onClick={() => setShowEdit(!showEdit)} disabled={imageFailed || isActionInProgress} className={`w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold rounded-md transition-colors disabled:opacity-50 ${showEdit ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}><SparklesIcon className="w-4 h-4" /> Edit Image</button>
                        )}

                        {showEdit && !imageFailed && videoState.status === 'idle' && (
                            <div className="space-y-3 mt-4 bg-gray-900/30 p-3 rounded-lg border border-purple-700/50">
                                <h4 className="font-semibold text-purple-300">Edit Image</h4>
                                <textarea className="w-full bg-gray-800 border border-gray-600 rounded-md text-gray-300 text-sm p-2 focus:ring-1 focus:ring-purple-500" placeholder="e.g., add a hat" rows={3} value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} disabled={isActionInProgress} />
                                <div className="flex items-center gap-2">
                                    <button onClick={() => { props.onEditImage(selectedSceneIndex, editPrompt); setShowEdit(false); }} disabled={!editPrompt || isActionInProgress} className="flex-grow bg-purple-600 text-white text-sm font-bold py-2 rounded-md hover:bg-purple-500 disabled:opacity-50">{isActionInProgress ? 'Applying...' : 'Apply Edit'}</button>
                                    {scene.previousSrc && !isActionInProgress && (
                                        <button
                                            onClick={() => props.onUndoEdit(selectedSceneIndex)}
                                            className="shrink-0 p-2 bg-gray-700 text-gray-300 rounded-md hover:bg-gray-600 transition-colors"
                                            title="Undo Last Edit"
                                        >
                                            <UndoIcon className="w-5 h-5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {!imageFailed && !showVideoControls && !videoState.showScriptInput && (
                            <div className="text-center mt-4">
                                <button onClick={() => props.onGenerateVideoToggle(selectedSceneIndex)} disabled={!isVideoAspectRatioSupported || isActionInProgress} className="inline-flex items-center gap-2 px-4 py-2 font-semibold text-white bg-green-600 rounded-md hover:bg-green-500 text-sm disabled:opacity-50"><VideoIcon className="w-5 h-5" /> Generate Video</button>
                                {!isVideoAspectRatioSupported && <p className="text-xs text-amber-400 mt-2">Video is only for 16:9 and 9:16.</p>}
                            </div>
                        )}
                        
                        {videoState.showScriptInput && videoState.status !== 'loading' && (
                            <div className="space-y-4 mt-4 bg-gray-900/50 p-3 rounded-lg border border-gray-700">
                                <h4 className="font-semibold text-white">Create Video</h4>
                                <div className="flex border-b border-gray-700">
                                    <button onClick={() => props.onVideoStateChange(selectedSceneIndex, { voiceoverMode: 'tts'})} className={`flex-1 text-sm py-1.5 rounded-t-md ${videoState.voiceoverMode === 'tts' ? 'bg-gray-700 font-semibold' : 'bg-transparent text-gray-400'}`}>Text-to-Speech</button>
                                    <button onClick={() => props.onVideoStateChange(selectedSceneIndex, { voiceoverMode: 'upload'})} className={`flex-1 text-sm py-1.5 rounded-t-md ${videoState.voiceoverMode === 'upload' ? 'bg-gray-700 font-semibold' : 'bg-transparent text-gray-400'}`}>Upload Audio</button>
                                </div>
                                <div className='p-1'>
                                {videoState.voiceoverMode === 'tts' ? (
                                    <div className="space-y-3">
                                        <SpeakerSelector characters={characters} scriptPrompt={videoState.scriptPrompt} />
                                        <textarea 
                                            className="w-full bg-gray-800 border border-gray-600 rounded-md text-gray-300 text-sm p-2 resize-none focus:ring-1 focus:ring-green-500" 
                                            placeholder={imageStyle === 'Nigerian Cartoon' ? "Write dialogue (AI will speak in Pidgin)..." : "Write dialogue or narration..."} 
                                            rows={4} 
                                            value={videoState.scriptPrompt} 
                                            onChange={(e) => props.onVideoStateChange(selectedSceneIndex, { scriptPrompt: e.target.value })} 
                                        />
                                    </div>
                                ) : (
                                     <div className="space-y-2">
                                        <label className="w-full text-center text-sm p-3 block bg-gray-800 border-2 border-dashed border-gray-600 rounded-md cursor-pointer hover:border-green-500">
                                            {videoState.voiceoverFile ? videoState.voiceoverFile.name : 'Choose audio file...'}
                                            <input type="file" accept="audio/*" className="hidden" onChange={(e) => props.onVideoStateChange(selectedSceneIndex, { voiceoverFile: e.target.files?.[0] || null })} />
                                        </label>
                                    </div>
                                )}
                                </div>
                                <CameraMovementSelector
                                    selectedMovement={videoState.cameraMovement}
                                    onSelect={(movement) => props.onVideoStateChange(selectedSceneIndex, { cameraMovement: movement })}
                                />
                                <button onClick={() => props.onConfirmGenerateVideo(scene, selectedSceneIndex)} className="w-full bg-green-600 text-white text-sm font-bold py-2 rounded-md hover:bg-green-500">Start Generation</button>
                            </div>
                        )}

                        {showVideoControls && (
                            <div className='space-y-3 mt-4'>
                              {videoState.status === 'success' && (
                                <button onClick={() => props.onExtendFromLastFrame(selectedSceneIndex)} className="inline-flex w-full justify-center items-center gap-2 px-3 py-2 text-sm font-semibold text-teal-300 bg-teal-800/50 rounded-md hover:bg-teal-700 transition-colors">
                                    <PlusCircleIcon className="w-4 h-4" /> Create from Last Frame
                                </button>
                              )}
                              <button onClick={() => props.onGenerateVideoToggle(selectedSceneIndex)} className="inline-flex w-full justify-center items-center gap-2 px-3 py-2 text-sm font-semibold text-gray-300 bg-gray-700 rounded-md hover:bg-gray-600 transition-colors">
                                  <RefreshIcon className="w-4 h-4" /> Regenerate Video
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

const ResultsView: React.FC<{
    appStatus: AppStatus;
    history: GenerationItem[];
    loadingMessage: string;
    savedItems: SavedItem[];
    uploadedItems: UploadedItem[];
    onToggleSave: (generationItem: GenerationItem, sceneIndex: number) => void;
    onGenerateVideoToggle: (generationId: number, sceneIndex: number) => void;
    onConfirmGenerateVideo: (generationId: number, scene: StoryboardScene, sceneIndex: number) => void;
    onExtendFromLastFrame: (generationId: number, sceneIndex: number) => void;
    onVideoStateChange: (generationId: number, sceneIndex: number, changes: Partial<VideoState>) => void;
    onDeleteVideo: (generationId: number, sceneIndex: number) => void;
    onDeleteClip: (generationId: number, sceneIndex: number, clipIndex: number) => void;
    onRegenerateImage: (generationId: number, sceneIndex: number) => void;
    onEditImage: (generationId: number, sceneIndex: number, editPrompt: string) => void;
    onUndoEdit: (generationId: number, sceneIndex: number) => void;
    onHydrateClips: (generationId: number, sceneIndex: number, clips: VideoClip[]) => void;
    onGenerateCameraAngles: (generationId: number, sceneIndex: number) => void;
    onDeleteScene: (generationId: number, sceneIndex: number) => void;
    onDeleteGeneration: (id: number) => void;
    // Props for UploadedItemManager
    onDeleteUploadedItem: (id: string) => void;
    onToggleSaveUploadedItem: (id: string, sceneIndex: number) => void;
    onGenerateVideoToggleForUploaded: (id: string, index: number) => void;
    onConfirmGenerateVideoForUploaded: (id: string, scene: StoryboardScene, index: number) => void;
    onExtendFromLastFrameForUploaded: (id: string, sceneIndex: number) => void;
    onVideoStateChangeForUploaded: (id: string, index: number, changes: Partial<VideoState>) => void;
    onDeleteVideoForUploaded: (id: string, index: number) => void;
    onDeleteClipForUploaded: (id: string, sceneIndex: number, clipIndex: number) => void;
    onEditImageForUploaded: (id: string, sceneIndex: number, editPrompt: string) => void;
    onUndoEditForUploaded: (id: string, sceneIndex: number) => void;
    onHydrateClipsForUploaded: (id: string, sceneIndex: number, clips: VideoClip[]) => void;
    onGenerateCameraAnglesForUploaded: (id: string, sceneIndex: number) => void;
    onDeleteSceneForUploaded: (id: string, sceneIndex: number) => void;
}> = (props) => {
    const { appStatus, history, loadingMessage, uploadedItems } = props;

    if (history.length === 0 && appStatus.status === 'idle' && uploadedItems.length === 0) {
        return (
            <div className="flex items-center justify-center w-full h-full border-2 border-dashed border-gray-700/50 rounded-xl bg-gray-500/5">
                <div className="text-center p-8">
                    <SparklesIcon className="mx-auto h-12 w-12 text-gray-600" />
                    <p className="mt-4 text-lg font-medium text-gray-400">Your creations will appear here</p>
                    <p className="text-sm text-gray-500 mt-1">Describe what you want to create and click Generate</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
             {uploadedItems.map(item => (
                 <UploadedItemManager
                    key={item.id}
                    uploadedItem={item}
                    onDelete={() => props.onDeleteUploadedItem(item.id)}
                    savedItems={props.savedItems}
                    onToggleSave={(sceneIndex) => props.onToggleSaveUploadedItem(item.id, sceneIndex)}
                    onGenerateVideoToggle={(index) => props.onGenerateVideoToggleForUploaded(item.id, index)}
                    onConfirmGenerateVideo={(scene, index) => props.onConfirmGenerateVideoForUploaded(item.id, scene, index)}
                    onExtendFromLastFrame={(index) => props.onExtendFromLastFrameForUploaded(item.id, index)}
                    onVideoStateChange={(index, changes) => props.onVideoStateChangeForUploaded(item.id, index, changes)}
                    onDeleteVideo={(index) => props.onDeleteVideoForUploaded(item.id, index)}
                    onDeleteClip={(sceneIndex, clipIndex) => props.onDeleteClipForUploaded(item.id, sceneIndex, clipIndex)}
                    onEditImage={(sceneIndex, editPrompt) => props.onEditImageForUploaded(item.id, sceneIndex, editPrompt)}
                    onUndoEdit={(sceneIndex) => props.onUndoEditForUploaded(item.id, sceneIndex)}
                    onHydrateClips={(sceneIndex, clips) => props.onHydrateClipsForUploaded(item.id, sceneIndex, clips)}
                    onGenerateCameraAngles={(index) => props.onGenerateCameraAnglesForUploaded(item.id, index)}
                    onDeleteScene={(sceneIndex) => props.onDeleteSceneForUploaded(item.id, sceneIndex)}
                 />
             ))}
            {appStatus.status === 'loading' && (
                <div className="flex flex-col items-center justify-center text-center p-8 bg-gray-800/50 rounded-xl w-full border border-gray-700">
                    <LoaderIcon className="w-12 h-12 text-indigo-400 animate-spin mb-4" />
                    <p className="text-lg text-gray-200">{loadingMessage}</p>
                    <p className="text-sm text-gray-400 mt-2">This may take a few moments. Previous results are shown below.</p>
                </div>
            )}

            {appStatus.status === 'error' && appStatus.error && (
                <div className="flex items-center justify-center p-8 bg-red-900/20 border border-red-500/50 rounded-xl w-full">
                    <div>
                        <h3 className="text-xl font-bold text-red-400 mb-2">An Error Occurred</h3>
                        <p className="text-red-300">{appStatus.error}</p>
                    </div>
                </div>
            )}

            {history.map((result) => (
                <GenerationResultItem
                    key={result.id}
                    generationItem={result}
                    savedItems={props.savedItems}
                    onToggleSave={props.onToggleSave}
                    onDelete={() => props.onDeleteGeneration(result.id)}
                    onGenerateVideoToggle={(index) => props.onGenerateVideoToggle(result.id, index)}
                    onConfirmGenerateVideo={(scene, index) => props.onConfirmGenerateVideo(result.id, scene, index)}
                    onExtendFromLastFrame={(index) => props.onExtendFromLastFrame(result.id, index)}
                    onVideoStateChange={(index, changes) => props.onVideoStateChange(result.id, index, changes)}
                    onDeleteVideo={(index) => props.onDeleteVideo(result.id, index)}
                    onDeleteClip={(sceneIndex, clipIndex) => props.onDeleteClip(result.id, sceneIndex, clipIndex)}
                    onRegenerateImage={(index) => props.onRegenerateImage(result.id, index)}
                    onEditImage={(sceneIndex, editPrompt) => props.onEditImage(result.id, sceneIndex, editPrompt)}
                    onUndoEdit={(sceneIndex) => props.onUndoEdit(result.id, sceneIndex)}
                    onHydrateClips={(sceneIndex, clips) => props.onHydrateClips(result.id, sceneIndex, clips)}
                    onGenerateCameraAngles={(index) => props.onGenerateCameraAngles(result.id, index)}
                    onDeleteScene={(index) => props.onDeleteScene(result.id, index)}
                />
            ))}
        </div>
    );
};


const CharacterManager: React.FC<{
    characters: Character[];
    setCharacters: React.Dispatch<React.SetStateAction<Character[]>>;
    isDisabled: boolean;
}> = ({ characters, setCharacters, isDisabled }) => {

    const addCharacter = () => {
        if (characters.length < 4) {
            setCharacters(prev => [...prev, { id: Date.now(), name: '', imagePreview: null, originalImageBase64: null, originalImageMimeType: null, description: null, detectedImageStyle: null, isDescribing: false }]);
        }
    };

    const removeCharacter = (id: number) => {
        const charToRemove = characters.find(c => c.id === id);
        if (charToRemove?.imagePreview) {
            URL.revokeObjectURL(charToRemove.imagePreview);
        }
        setCharacters(prev => prev.filter(c => c.id !== id));
    };

    const updateCharacterName = (id: number, name: string) => {
        setCharacters(prev => prev.map(c => c.id === id ? { ...c, name } : c));
    };

    const updateCharacterDescription = (id: number, description: string) => {
        setCharacters(prev => prev.map(c => c.id === id ? { ...c, description } : c));
    };

    const handleCharacterImageUpload = async (id: number, file: File) => {
        const previewUrl = URL.createObjectURL(file);
        const oldChar = characters.find(c => c.id === id);
        if (oldChar?.imagePreview) {
            URL.revokeObjectURL(oldChar.imagePreview);
        }
        setCharacters(prev => prev.map(c => c.id === id ? { ...c, imagePreview: previewUrl, isDescribing: true } : c));
        try {
            const base64 = await fileToBase64(file);
            const { description, detectedStyle } = await generateCharacterDescription(base64, file.type);
            setCharacters(prev => prev.map(c => c.id === id ? { ...c, description, detectedImageStyle: detectedStyle, originalImageBase64: base64, originalImageMimeType: file.type, isDescribing: false } : c));
        } catch (error) {
            console.error("Failed to generate character description:", error);
            setCharacters(prev => prev.map(c => c.id === id ? { ...c, isDescribing: false } : c));
        }
    };

    return (
        <div className="space-y-3">
            {characters.map((char) => (
                <div key={char.id} className="flex items-start gap-3 bg-gray-800/50 p-2.5 rounded-lg">
                    <label className="w-16 h-16 bg-gray-700 rounded-lg flex items-center justify-center cursor-pointer hover:bg-gray-600 relative shrink-0">
                        <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            disabled={isDisabled || char.isDescribing}
                            onChange={(e) => {
                                if (e.target.files?.[0]) {
                                    handleCharacterImageUpload(char.id, e.target.files[0]);
                                }
                            }}
                        />
                        {char.imagePreview ? (
                            <img src={char.imagePreview} alt={char.name} className="w-full h-full object-cover rounded-md" />
                        ) : (
                            <span className="text-xs text-gray-400 text-center">Upload Face</span>
                        )}
                        {char.isDescribing && (
                            <div className="absolute inset-0 bg-black/70 flex items-center justify-center rounded-md">
                                <LoaderIcon className="w-6 h-6 animate-spin text-white" />
                            </div>
                        )}
                    </label>
                    <div className="flex-1 space-y-2">
                        <input
                            type="text"
                            placeholder="Character Name"
                            value={char.name}
                            disabled={isDisabled}
                            onChange={(e) => updateCharacterName(char.id, e.target.value)}
                            className="w-full bg-gray-700 border border-gray-600 text-white text-sm rounded-md p-1.5 focus:ring-1 focus:ring-indigo-500"
                        />
                        <textarea
                            placeholder={char.isDescribing ? 'AI is analyzing...' : 'AI description will appear here.'}
                            value={char.description || ''}
                            disabled={isDisabled || char.isDescribing}
                            onChange={(e) => updateCharacterDescription(char.id, e.target.value)}
                            className="w-full text-xs h-10 bg-gray-700/50 border border-transparent text-gray-300 rounded-md p-1 resize-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                            rows={2}
                        />
                    </div>
                    <button
                        onClick={() => removeCharacter(char.id)}
                        disabled={isDisabled || char.isDescribing}
                        className="text-gray-500 hover:text-red-400 disabled:text-gray-600"
                    >
                        <XCircleIcon className="w-5 h-5" />
                    </button>
                </div>
            ))}
            {characters.length < 4 && (
                <button
                    onClick={addCharacter}
                    disabled={isDisabled}
                    className="w-full flex items-center justify-center gap-2 p-2 text-sm font-semibold text-indigo-300 bg-indigo-500/10 rounded-md hover:bg-indigo-500/20 transition-colors disabled:bg-gray-700 disabled:text-gray-500"
                >
                    <UserPlusIcon className="w-5 h-5" />
                    Add Character
                </button>
            )}
        </div>
    );
};

const calculateTimeRemaining = (expiresAt: number): string => {
    const now = Date.now();
    const diff = expiresAt - now;
    if (diff <= 0) return "Expired";
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days > 0) return `Expires in ${days} day${days > 1 ? 's' : ''}`;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours > 0) return `Expires in ${hours} hour${hours > 1 ? 's' : ''}`;
    const minutes = Math.floor(diff / (1000 * 60));
    return `Expires in ${minutes} min${minutes > 1 ? 's' : ''}`;
};


const SavedItemsManager: React.FC<{
    savedItems: SavedItem[];
    onUnsave: (itemId: string) => void;
    onSelect: (item: SavedItem) => void;
}> = ({ savedItems, onUnsave, onSelect }) => {
    
    if (savedItems.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 p-4">
                <BookmarkIcon className="w-12 h-12 mb-2" />
                <h4 className="font-semibold text-gray-300">No Saved Items</h4>
                <p className="text-sm">Bookmark your favorite generations to find them here later.</p>
                <p className="text-xs mt-2">Double-click a saved item to open the editor.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {savedItems.sort((a,b) => b.expiresAt - a.expiresAt).map(item => (
                <div 
                    key={item.id} 
                    className="bg-gray-800/50 p-3 rounded-lg flex gap-3 relative cursor-pointer hover:bg-gray-700/50 transition-colors"
                    onDoubleClick={() => onSelect(item)}
                >
                     <div className="w-24 h-24 shrink-0 relative">
                        <img src={`data:image/png;base64,${item.scene.src}`} alt="Saved item" className="w-full h-full object-cover rounded-md"/>
                        {item.videoState?.status === 'success' && (
                            <div className="absolute bottom-1 right-1 bg-black/60 p-1 rounded-full backdrop-blur-sm">
                                <VideoIcon className="w-4 h-4 text-green-300" />
                            </div>
                        )}
                     </div>
                     <div className="overflow-hidden">
                        <p className="text-xs text-indigo-400 font-semibold truncate">{item.imageStyle} &bull; {item.aspectRatio}</p>
                        <p className="text-sm text-gray-300 mt-1 line-clamp-2">{item.scene.prompt}</p>
                        <p className="text-xs text-gray-500 mt-2 font-mono">{calculateTimeRemaining(item.expiresAt)}</p>
                     </div>
                     <button onClick={(e) => { e.stopPropagation(); onUnsave(item.id);}} className="absolute top-2 right-2 text-gray-500 hover:text-red-400">
                        <XCircleIcon className="w-5 h-5" />
                     </button>
                </div>
            ))}
        </div>
    );
}

const CameraAngleModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSubmit: () => void;
    selectedAngles: { front: boolean; back: boolean; side: boolean; };
    setSelectedAngles: React.Dispatch<React.SetStateAction<{ front: boolean; back: boolean; side: boolean; }>>;
}> = ({ isOpen, onClose, onSubmit, selectedAngles, setSelectedAngles }) => {
    if (!isOpen) return null;

    const toggleAngle = (angle: 'front' | 'back' | 'side') => {
        setSelectedAngles(prev => ({ ...prev, [angle]: !prev[angle] }));
    };

    const enabledCount = Object.values(selectedAngles).filter(Boolean).length;

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden border border-gray-700" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-gray-700">
                    <h3 className="text-lg font-bold text-white">Select Camera Angles</h3>
                    <p className="text-sm text-gray-400">Choose which views to generate.</p>
                </div>
                <div className="p-6 space-y-4">
                    {Object.entries({ front: 'Front View', back: 'Back View', side: 'Side View' }).map(([key, label]) => (
                        <label key={key} className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg cursor-pointer hover:bg-gray-700/50">
                            <span className="font-semibold text-gray-300">{label}</span>
                            <input
                                type="checkbox"
                                checked={selectedAngles[key as 'front' | 'back' | 'side']}
                                onChange={() => toggleAngle(key as 'front' | 'back' | 'side')}
                                className="w-5 h-5 rounded bg-gray-700 border-gray-600 text-indigo-500 focus:ring-2 focus:ring-indigo-500"
                            />
                        </label>
                    ))}
                </div>
                <div className="p-4 bg-gray-900/50 border-t border-gray-700 flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-300 bg-gray-700/80 rounded-md hover:bg-gray-600/80">
                        Cancel
                    </button>
                    <button onClick={onSubmit} disabled={enabledCount === 0} className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-not-allowed">
                        Generate {enabledCount > 0 ? `${enabledCount} View${enabledCount > 1 ? 's' : ''}`: ''}
                    </button>
                </div>
            </div>
        </div>
    );
};

const AudioAssignmentManager: React.FC<{
    assignment: AudioAssignment;
    onAssign: (newAssignment: { type: 'character'; characterId: number } | { type: 'background' } | null) => void;
    isDisabled: boolean;
}> = ({ assignment, onAssign, isDisabled }) => {
    
    const { transcription, detectedCharacters, assignment: currentAssignment } = assignment;
    const canAssign = detectedCharacters.length > 0;
    
    return (
        <div className="space-y-3 mt-4 p-3 bg-gray-900/50 border border-gray-700 rounded-lg">
            <div>
                <h4 className="text-sm font-semibold text-green-300 uppercase tracking-wider mb-2">Uploaded Audio</h4>
                <p className="text-xs text-gray-400 bg-black/20 p-2 rounded-md font-mono italic">"{transcription}"</p>
            </div>
            {canAssign && (
                 <div>
                    <h5 className="font-semibold text-white text-sm mb-2">How should this audio be used for video?</h5>
                    <div className="flex flex-wrap gap-2">
                        {detectedCharacters.map(char => (
                            <button
                                key={char.id}
                                disabled={isDisabled}
                                onClick={() => onAssign({ type: 'character', characterId: char.id })}
                                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors text-center border ${
                                    currentAssignment?.type === 'character' && currentAssignment.characterId === char.id
                                        ? 'bg-green-600 text-white border-green-500 shadow-md'
                                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-gray-600'
                                }`}
                            >
                                Assign to: {char.name}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <div>
                 <button
                    disabled={isDisabled}
                    onClick={() => onAssign({ type: 'background' })}
                    className={`w-full px-3 py-1.5 mt-2 text-sm font-semibold rounded-md transition-colors text-center border ${
                        currentAssignment?.type === 'background'
                            ? 'bg-indigo-600 text-white border-indigo-500 shadow-md'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border-gray-600'
                    }`}
                >
                    Use as Background Sound
                </button>
            </div>
        </div>
    );
};

const extractFrameAsBase64 = (videoUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = "anonymous";
        video.preload = 'metadata';

        video.onloadedmetadata = () => {
            video.currentTime = Math.max(0, video.duration - 0.1); 
        };

        video.onseeked = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return reject(new Error('Could not get canvas context.'));
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const base64 = canvas.toDataURL('image/png').split(',')[1];
                if (!base64) {
                     return reject(new Error('Canvas toDataURL returned empty.'));
                }
                resolve(base64); 
            } catch (e) {
                reject(e);
            }
        };

        video.onerror = (e) => {
            reject(new Error('Failed to load video for frame extraction.'));
        };

        video.src = videoUrl;
    });
};


export default function App() {
  const getInitialVideoState = (): VideoState => ({
    status: 'idle', clips: [], currentClipIndex: 0, error: null, loadingMessage: '', showScriptInput: false, scriptPrompt: '', voiceoverMode: 'tts', voiceoverFile: null, speaker: 'Narrator', cameraMovement: 'Static Hold',
  });

  const [promptText, setPromptText] = useState<string>('');
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState<boolean>(false);
  const [appStatus, setAppStatus] = useState<AppStatus>({ status: 'idle', error: null });
  const [generationHistory, setGenerationHistory] = useState<GenerationItem[]>([]);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [imageCount, setImageCount] = useState<number>(1);
  const [aspectRatio, setAspectRatio] = useState<string>('16:9');
  const [imageStyle, setImageStyle] = useState<string>('Nigerian Cartoon');
  const [imageModel, setImageModel] = useState<string>('gemini-2.5-flash-image');
  const [videoModel, setVideoModel] = useState<string>('veo-3.1-fast-generate-preview');
  const [videoResolution, setVideoResolution] = useState<'720p' | '1080p'>('720p');
  const [genre, setGenre] = useState<string>('General');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
  const [activeTab, setActiveTab] = useState<'controls' | 'saved'>('controls');
  
  const [audioAssignment, setAudioAssignment] = useState<AudioAssignment | null>(null);
  const [uploadedItems, setUploadedItems] = useState<UploadedItem[]>([]);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  
  const [angleModal, setAngleModal] = useState({ isOpen: false, generationId: 0, sceneIndex: 0, isUploaded: false, uploadedId: '' });
  const [selectedAngles, setSelectedAngles] = useState({ front: true, back: true, side: true });


  useEffect(() => {
    const fetchItems = async () => {
      try {
        const items = await loadItems();
        setSavedItems(items);
      } catch (error) {
        console.error("Failed to load saved items", error);
      }
    };
    fetchItems();
  }, []);

  const handleVideoGenerationError = useCallback(async (
      error: unknown,
      updateState: (changes: Partial<VideoState>) => void,
      logContext: string
  ) => {
      const displayError = parseErrorMessage(error);
      console.error(logContext, error);
      updateState({ status: 'error', error: displayError });
      if (error instanceof Error && error.message.toLowerCase().includes("requested entity was not found")) {
          if (typeof window !== 'undefined' && window.aistudio && typeof window.aistudio.openSelectKey === 'function') {
              await window.aistudio.openSelectKey();
              updateState({ status: 'idle' }); 
          }
      }
  }, []);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      const file = event.target.files[0];
      setPromptText('');
      setIsGeneratingPrompt(true);
      setAudioAssignment(null);
      try {
        const audioBase64 = await fileToBase64(file);
        const transcription = await generatePromptFromAudio(audioBase64, file.type);
        setPromptText(transcription);

        if (transcription) {
          const detectedCharacters = characters.filter(c => 
              c.name && transcription.toLowerCase().includes(c.name.toLowerCase())
          );
          setAudioAssignment({ file, transcription, detectedCharacters, assignment: null });
        }
      } catch (err) {
        setAppStatus({ status: 'error', error: 'Could not generate prompt from audio.' });
        setAudioAssignment(null);
      } finally {
        setIsGeneratingPrompt(false);
      }
    }
  };

  const handleImageUploadForVideo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.[0]) return;
    const file = event.target.files[0];
    setAppStatus({ status: 'loading', error: null });
    setLoadingMessage("Processing uploaded image...");

    try {
        const base64 = await fileToBase64(file);
        const fileName = file.name;
        let detectedCharacters: string[] = [];
        const marker = '--chars--[';
        const markerIndex = fileName.lastIndexOf(marker);

        if (markerIndex !== -1) {
            const start = markerIndex + marker.length;
            const end = fileName.lastIndexOf(']');
            if (end > start) {
                const charsString = fileName.substring(start, end);
                detectedCharacters = charsString.split(',').map(name => name.trim()).filter(Boolean);
            }
        }

        const existingCharNamesLower = new Set(characters.map(c => c.name.toLowerCase()));
        const previewUrl = URL.createObjectURL(file);

        const newCharactersToAdd = detectedCharacters
            .filter(name => !existingCharNamesLower.has(name.toLowerCase()))
            .map(name => ({
                id: Date.now() + Math.random(),
                name: name,
                imagePreview: previewUrl,
                originalImageBase64: base64,
                originalImageMimeType: file.type,
                description: null,
                detectedImageStyle: null,
                isDescribing: true,
            }));

        if (newCharactersToAdd.length > 0) {
            setCharacters(prev => [...prev, ...newCharactersToAdd]);
            newCharactersToAdd.forEach(async (newChar) => {
                try {
                    const { description, detectedStyle } = await generateCharacterDescription(base64, file.type);
                    setCharacters(prev => prev.map(c =>
                        c.id === newChar.id
                            ? { ...c, description, detectedStyle: detectedStyle, isDescribing: false }
                            : c
                    ));
                } catch (error) {
                    console.error(`Failed to generate description for ${newChar.name}:`, error);
                    setCharacters(prev => prev.map(c =>
                        c.id === newChar.id ? { ...c, isDescribing: false } : c
                    ));
                }
            });
        }
        
        const getAspectRatio = (width: number, height: number): string => {
            const ratio = width / height;
            const tolerance = 0.1;
            if (Math.abs(ratio - (16 / 9)) < tolerance) return '16:9';
            if (Math.abs(ratio - (9 / 16)) < tolerance) return '9:16';
            if (Math.abs(ratio - 1) < tolerance) return '1:1';
            return Math.abs(ratio - (16 / 9)) < Math.abs(ratio - (9 / 16)) ? '16:9' : '9:16';
        };
  
        const img = new Image();
        img.onload = () => {
          const determinedAspectRatio = getAspectRatio(img.width, img.height);
          const newUploadedItem: UploadedItem = {
            id: `uploaded-${Date.now()}`,
            generationItem: {
              prompt: 'Uploaded Image',
              imageSet: [{ src: base64, prompt: 'An uploaded image provided by the user for animation.' }],
              aspectRatio: determinedAspectRatio,
              imageStyle: imageStyle,
              imageModel: imageModel,
              genre: genre,
              characters: [...characters, ...newCharactersToAdd],
            },
            videoStates: [getInitialVideoState()],
            mimeType: file.type,
            detectedCharacters,
            addedCharacterIds: newCharactersToAdd.map(c => c.id),
          };

          setUploadedItems(prev => [...prev, newUploadedItem]);
          setAppStatus({ status: 'idle', error: null });
          setLoadingMessage("");
          URL.revokeObjectURL(img.src);
        };
        img.onerror = () => {
          setAppStatus({ status: 'error', error: 'Could not load the uploaded image file.' });
          setLoadingMessage("");
          URL.revokeObjectURL(img.src);
        }
        img.src = URL.createObjectURL(file);
      } catch (error) {
        setAppStatus({ status: 'error', error: 'Failed to process the image file.' });
        setLoadingMessage("");
      } finally {
        if (event.target) event.target.value = '';
      }
  };

  const handleClearAudio = () => {
    setAudioAssignment(null);
    setPromptText('');
    const fileInput = document.getElementById('audio-upload') as HTMLInputElement;
    if (fileInput) {
        fileInput.value = '';
    }
  };
  
  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPromptText(event.target.value);
    if(event.target.value) {
        setAudioAssignment(null);
    }
  }

  const handleVideoStateChange = useCallback((generationId: number, sceneIndex: number, changes: Partial<VideoState>) => {
      setGenerationHistory(prev =>
        prev.map(item => {
            if (item.id !== generationId) return item;

            const newVideoStates = [...item.videoStates];
            if (newVideoStates[sceneIndex]) {
                newVideoStates[sceneIndex] = { ...newVideoStates[sceneIndex], ...changes };
            }
            return { ...item, videoStates: newVideoStates };
        })
    );
  }, []);

  const handleDeleteVideo = useCallback((generationId: number, sceneIndex: number) => {
      handleVideoStateChange(generationId, sceneIndex, getInitialVideoState());
  }, [handleVideoStateChange]);

  const handleDeleteClip = useCallback((generationId: number, sceneIndex: number, clipIndex: number) => {
    setGenerationHistory(prev =>
        prev.map(item => {
            if (item.id !== generationId) return item;

            const newVideoStates = [...item.videoStates];
            const currentVideoState = newVideoStates[sceneIndex];

            if (currentVideoState && currentVideoState.clips.length > clipIndex) {
                const newClips = currentVideoState.clips.filter((_, index) => index !== clipIndex);

                if (newClips.length === 0) {
                    newVideoStates[sceneIndex] = getInitialVideoState();
                } else {
                    let newClipIndex = currentVideoState.currentClipIndex;
                    if (newClipIndex >= newClips.length) {
                        newClipIndex = newClips.length - 1;
                    }
                     if (newClipIndex < 0) {
                        newClipIndex = 0;
                    }
                    newVideoStates[sceneIndex] = {
                        ...currentVideoState,
                        clips: newClips,
                        currentClipIndex: newClipIndex,
                    };
                }
            }
            return { ...item, videoStates: newVideoStates };
        })
    );
  }, []);

  const handleToggleSaveScene = useCallback(async (generationItem: GenerationItem, sceneIndex: number) => {
    const scene = generationItem.imageSet[sceneIndex];
    if (!scene || !scene.src) return;
    const itemId = `${generationItem.id}-${sceneIndex}`;
    const videoState = generationItem.videoStates[sceneIndex];

    const isAlreadySaved = savedItems.some(item => item.id === itemId);
    let newItems;
    if (isAlreadySaved) {
        newItems = savedItems.filter(item => item.id !== itemId);
    } else {
        const serializableVideoState = {
            ...videoState,
            voiceoverFile: null,
        };

        const newItem: SavedItem = {
            id: itemId,
            scene: scene,
            videoState: serializableVideoState,
            originalPrompt: generationItem.prompt,
            aspectRatio: generationItem.aspectRatio,
            imageStyle: generationItem.imageStyle,
            imageModel: generationItem.imageModel,
            genre: generationItem.genre,
            characters: JSON.parse(JSON.stringify(generationItem.characters)), // Take a deep copy
            expiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
        };
        newItems = [newItem, ...savedItems];
    }
    await saveItems(newItems);
    setSavedItems(newItems);
  }, [savedItems]);

    const handleUnsaveScene = useCallback(async (itemId: string) => {
        const newItems = savedItems.filter(item => item.id !== itemId);
        await saveItems(newItems);
        setSavedItems(newItems);
    }, [savedItems]);

  const handleGenerateImage = useCallback(async () => {
    if (!promptText) {
      setAppStatus({ status: 'error', error: 'Please enter a prompt or upload audio to generate one.' });
      return;
    }
    setAppStatus({ status: 'loading', error: null });
    setLoadingMessage('Initializing...');
    
    try {
      const result = await generateImageSet(promptText, imageCount, aspectRatio, imageStyle, genre, characters.filter(c => c.name && c.description), characters, imageModel, (message) => setLoadingMessage(message));
      
      const newGenerationItem: GenerationItem = {
        id: Date.now(),
        prompt: promptText,
        imageSet: result.storyboard,
        videoStates: new Array(result.storyboard.length).fill(null).map(() => getInitialVideoState()),
        aspectRatio,
        imageStyle,
        imageModel,
        genre,
        characters: JSON.parse(JSON.stringify(characters))
      };

      setGenerationHistory(prev => [newGenerationItem, ...prev]);
      setAppStatus({ status: 'idle', error: null });
    } catch (err) {
        console.error('Image generation failed:', err);
        const displayError = parseErrorMessage(err);
        setAppStatus({ status: 'error', error: displayError });
    }
  }, [promptText, imageCount, aspectRatio, imageStyle, imageModel, genre, characters]);

  const handleOpenAngleModal = useCallback((generationId: number, sceneIndex: number) => {
      setAngleModal({ isOpen: true, generationId, sceneIndex, isUploaded: false, uploadedId: '' });
  }, []);

  const handleOpenAngleModalForUploaded = useCallback((id: string, sceneIndex: number) => {
    setAngleModal({ isOpen: true, generationId: 0, sceneIndex, isUploaded: true, uploadedId: id });
  }, []);

  const handleGenerateCameraAnglesForUploaded = useCallback(async () => {
    const { sceneIndex, uploadedId } = angleModal;
    setAngleModal({ isOpen: false, generationId: 0, sceneIndex: 0, isUploaded: false, uploadedId: '' });

    const angleNames = Object.entries(selectedAngles).filter(([, isSelected]) => isSelected).map(([name]) => name);
    if (angleNames.length === 0) return;

    const uploadedItem = uploadedItems.find(item => item.id === uploadedId);
    if (!uploadedItem) return;

    const sceneToUpdate = uploadedItem.generationItem.imageSet[sceneIndex];
    if (!sceneToUpdate || !sceneToUpdate.src) return;

    setUploadedItems(prev => prev.map(item => item.id === uploadedId ? {
        ...item,
        generationItem: { ...item.generationItem, imageSet: item.generationItem.imageSet.map((s, i) => i === sceneIndex ? { ...s, isGeneratingAngles: true } : s) }
    } : item));


    try {
        const { generationItem } = uploadedItem;
        const newScenes = await generateCameraAnglesFromImage(sceneToUpdate, {
            aspectRatio: generationItem.aspectRatio,
            imageStyle: generationItem.imageStyle,
            imageModel: generationItem.imageModel,
            genre: generationItem.genre,
            characters: generationItem.characters,
        }, angleNames, () => {});

        setUploadedItems(prev => prev.map(item => {
            if (item.id !== uploadedId) return item;
            const newImageSet = [...item.generationItem.imageSet];
            const newVideoStates = [...item.videoStates];
            const updatedImageSet = newImageSet.map(scene => scene.isCameraAngleFor !== undefined && scene.isCameraAngleFor > sceneIndex ? { ...scene, isCameraAngleFor: scene.isCameraAngleFor + newScenes.length } : scene);
            updatedImageSet.splice(sceneIndex + 1, 0, ...newScenes.map(s => ({ ...s, isCameraAngleFor: sceneIndex })));
            newVideoStates.splice(sceneIndex + 1, 0, ...new Array(newScenes.length).fill(null).map(() => getInitialVideoState()));
            updatedImageSet[sceneIndex] = { ...updatedImageSet[sceneIndex], isGeneratingAngles: false, error: null };
            return { ...item, generationItem: { ...item.generationItem, imageSet: updatedImageSet }, videoStates: newVideoStates };
        }));
    } catch (error) {
        const parsedError = parseErrorMessage(error);
        console.error(`Uploaded camera angle generation failed:`, parsedError);
        setUploadedItems(prev => prev.map(item => item.id === uploadedId ? {
            ...item,
            generationItem: { ...item.generationItem, imageSet: item.generationItem.imageSet.map((s, i) => i === sceneIndex ? { ...s, isGeneratingAngles: false, error: `Angle generation failed: ${parsedError}` } : s) }
        }: item));
    }
  }, [uploadedItems, selectedAngles, angleModal]);

  const handleConfirmAngleGeneration = useCallback(async () => {
    if (angleModal.isUploaded) {
        await handleGenerateCameraAnglesForUploaded();
        return;
    }
    const { generationId, sceneIndex } = angleModal;
    setAngleModal({ isOpen: false, generationId: 0, sceneIndex: 0, isUploaded: false, uploadedId: '' });

    const angleNames = Object.entries(selectedAngles).filter(([, isSelected]) => isSelected).map(([name]) => name);
    if (angleNames.length === 0) return;

    const generationItem = generationHistory.find(item => item.id === generationId);
    if (!generationItem) return;

    const sceneToUpdate = generationItem.imageSet[sceneIndex];
    if (!sceneToUpdate || !sceneToUpdate.src) return;

    setGenerationHistory(prev => prev.map(item =>
        item.id === generationId ? { ...item, imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, isGeneratingAngles: true } : s) } : item
    ));

    try {
        const newScenes = await generateCameraAnglesFromImage(sceneToUpdate, {
            aspectRatio: generationItem.aspectRatio, imageStyle: generationItem.imageStyle, imageModel: generationItem.imageModel, genre: generationItem.genre, characters: generationItem.characters,
        }, angleNames, () => {});

        setGenerationHistory(prev => prev.map(item => {
            if (item.id !== generationId) return item;
            const newImageSet = [...item.imageSet];
            const newVideoStates = [...item.videoStates];
            const updatedImageSet = newImageSet.map(scene => scene.isCameraAngleFor !== undefined && scene.isCameraAngleFor > sceneIndex ? { ...scene, isCameraAngleFor: scene.isCameraAngleFor + newScenes.length } : scene);
            updatedImageSet.splice(sceneIndex + 1, 0, ...newScenes.map(s => ({ ...s, isCameraAngleFor: sceneIndex })));
            newVideoStates.splice(sceneIndex + 1, 0, ...new Array(newScenes.length).fill(null).map(() => getInitialVideoState()));
            updatedImageSet[sceneIndex] = { ...updatedImageSet[sceneIndex], isGeneratingAngles: false, error: null };
            return { ...item, imageSet: updatedImageSet, videoStates: newVideoStates };
        }));
    } catch (error) {
        const parsedError = parseErrorMessage(error);
        setGenerationHistory(prev => prev.map(item =>
            item.id === generationId ? { ...item, imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, isGeneratingAngles: false, error: `Angle generation failed: ${parsedError}` } : s) } : item
        ));
    }
  }, [generationHistory, selectedAngles, handleGenerateCameraAnglesForUploaded, angleModal]);


  const handleRegenerateImage = useCallback(async (generationId: number, sceneIndex: number) => {
    const generationItem = generationHistory.find(item => item.id === generationId);
    if (!generationItem) return;

    const sceneToRegenerate = generationItem.imageSet[sceneIndex];
    if (!sceneToRegenerate) return;

    setGenerationHistory(prev => prev.map(item => item.id === generationId ? {
        ...item,
        imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, isRegenerating: true } : s)
    } : item));
    
    try {
        let referenceImageSrc: string | null = null;
        
        const validCharactersForPrompt = generationItem.characters.filter(c => c.name && c.description);
        
        const { src: newImageSrc, error: newImageError } = await generateSingleImage(
            sceneToRegenerate.prompt,
            generationItem.aspectRatio,
            generationItem.imageStyle,
            generationItem.genre, // Use generationItem.genre for consistency
            validCharactersForPrompt, // For prompt content
            generationItem.characters, // All characters for style detection
            generationItem.imageModel,
            referenceImageSrc
        );
        
        setGenerationHistory(prev => prev.map(item => item.id === generationId ? {
            ...item,
            imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, src: newImageSrc, error: newImageError, isRegenerating: false } : s)
        } : item));
    } catch (error) {
        const parsedError = parseErrorMessage(error);
        console.error(`Image regeneration for scene ${sceneIndex + 1} failed:`, parsedError);
        setGenerationHistory(prev => prev.map(item => item.id === generationId ? {
            ...item,
            imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, error: parsedError, isRegenerating: false } : s)
        } : item));
    }
  }, [generationHistory]);

    const handleEditImage = useCallback(async (generationId: number, sceneIndex: number, editPrompt: string) => {
        const generationItem = generationHistory.find(item => item.id === generationId);
        if (!generationItem) return;

        const sceneToEdit = generationItem.imageSet[sceneIndex];
        if (!sceneToEdit || !sceneToEdit.src) return;
        
        const newPreviousSrc = sceneToEdit.src;

        setGenerationHistory(prev => prev.map(item => item.id === generationId ? {
            ...item,
            imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, isEditing: true, previousSrc: newPreviousSrc } : s)
        } : item));
        
        try {
            const { src: newImageSrc, error: newImageError } = await editImage({
                imageBase64: sceneToEdit.src,
                mimeType: 'image/png', // The app generates PNGs
                editPrompt: editPrompt,
                aspectRatio: generationItem.aspectRatio,
                imageStyle: generationItem.imageStyle,
                genre: generationItem.genre,
                characters: generationItem.characters,
            });
            
            setGenerationHistory(prev => prev.map(item => item.id === generationId ? {
                ...item,
                imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, src: newImageSrc, error: newImageError, isEditing: false } : s)
            } : item));
        } catch (error) {
            const parsedError = parseErrorMessage(error);
            console.error(`Image editing for scene ${sceneIndex + 1} failed:`, parsedError);
            setGenerationHistory(prev => prev.map(item => item.id === generationId ? {
                ...item,
                imageSet: item.imageSet.map((s, i) => i === sceneIndex ? { ...s, error: parsedError, isEditing: false } : s)
            } : item));
        }
    }, [generationHistory]);

    const handleUndoEdit = useCallback((generationId: number, sceneIndex: number) => {
        setGenerationHistory(prev => prev.map(item => {
            if (item.id !== generationId) return item;
            const newImageSet = item.imageSet.map((s, i) => {
                if (i === sceneIndex && s.previousSrc) {
                    return { ...s, src: s.previousSrc, previousSrc: null };
                }
                return s;
            });
            return { ...item, imageSet: newImageSet };
        }));
    }, []);


  const handleGenerateVideoToggle = useCallback((generationId: number, sceneIndex: number) => {
    const generationItem = generationHistory.find(item => item.id === generationId);
    const currentState = generationItem?.videoStates[sceneIndex];
    if (currentState) {
      handleVideoStateChange(generationId, sceneIndex, { showScriptInput: !currentState.showScriptInput });
    }
  }, [generationHistory, handleVideoStateChange]);

  const handleConfirmGenerateVideo = useCallback(async (generationId: number, scene: StoryboardScene, sceneIndex: number) => {
    const generationItem = generationHistory.find(item => item.id === generationId);
    if (!generationItem || !scene.src) return; 

    handleVideoStateChange(generationId, sceneIndex, { status: 'loading', error: null, showScriptInput: false, loadingMessage: 'Initializing video generation...' });
    
    try {
      if (typeof window !== 'undefined' && window.aistudio && typeof window.aistudio.hasSelectedApiKey === 'function' && typeof window.aistudio.openSelectKey === 'function') {
        if (!await window.aistudio.hasSelectedApiKey()) {
          await window.aistudio.openSelectKey();
        }
      }
      let audioOptions: AudioOptions | null = null;
      const videoState = generationItem.videoStates[sceneIndex];

      if (audioAssignment?.file && audioAssignment.assignment) {
          const assignedChar = characters.find(c => c.id === (audioAssignment.assignment as any).characterId);
          audioOptions = {
              mode: 'upload',
              data: await fileToBase64(audioAssignment.file),
              mimeType: audioAssignment.file.type,
              assignment: audioAssignment.assignment.type === 'character' && assignedChar
                  ? { type: 'character', characterName: assignedChar.name }
                  : { type: 'background' }
          };
      } else if (videoState.voiceoverMode === 'upload' && videoState.voiceoverFile) { 
          audioOptions = { mode: 'upload', data: await fileToBase64(videoState.voiceoverFile), mimeType: videoState.voiceoverFile.type }; 
      } else if (videoState.voiceoverMode === 'tts' && videoState.scriptPrompt) { 
          audioOptions = { mode: 'tts', data: videoState.scriptPrompt }; 
      }
      
      const { videoUrl, audioUrl, videoObject, audioBase64 } = await generateVideoFromScene(scene, generationItem.aspectRatio, videoState.scriptPrompt, generationItem.characters, audioOptions, generationItem.imageStyle, videoModel, videoResolution, videoState.cameraMovement, (message) => handleVideoStateChange(generationId, sceneIndex, { loadingMessage: message }));
      handleVideoStateChange(generationId, sceneIndex, { status: 'success', clips: [{ videoUrl, audioUrl, videoObject, audioBase64 }], currentClipIndex: 0 });
    } catch (err) {
        const context = `Video generation for scene ${sceneIndex + 1} failed:`;
        await handleVideoGenerationError(err, (changes) => handleVideoStateChange(generationId, sceneIndex, changes), context);
    }
  }, [generationHistory, handleVideoStateChange, handleVideoGenerationError, videoModel, videoResolution, audioAssignment, characters]);

  const handleHydrateClips = useCallback((generationId: number, sceneIndex: number, clips: VideoClip[]) => {
      handleVideoStateChange(generationId, sceneIndex, { clips });
  }, [handleVideoStateChange]);

  const handleSelectSavedItem = (item: SavedItem) => {
    const generationItemFromSaved: Omit<GenerationItem, 'id' | 'videoStates'> & { imageSet: AppStoryboardScene[] } = {
        prompt: item.originalPrompt,
        imageSet: [item.scene],
        aspectRatio: item.aspectRatio,
        imageStyle: item.imageStyle,
        imageModel: item.imageModel,
        genre: item.genre,
        characters: item.characters,
    };

    const restoredVideoState = item.videoState || getInitialVideoState();

    const newUploadedItem: UploadedItem = {
        id: `uploaded-from-saved-${item.id}`,
        generationItem: generationItemFromSaved,
        videoStates: [restoredVideoState],
        mimeType: 'image/png',
        detectedCharacters: item.characters.map(c => c.name).filter(Boolean),
    };

    setUploadedItems(prev => [...prev, newUploadedItem]);
    setActiveTab('controls');
};
 
 const handleDeleteUploadedItem = (id: string) => {
    setUploadedItems(prev => {
        const itemToDelete = prev.find(item => item.id === id);
        if (!itemToDelete) return prev;

        if (itemToDelete.addedCharacterIds && itemToDelete.addedCharacterIds.length > 0) {
            const idsToRemove = new Set(itemToDelete.addedCharacterIds);
            setCharacters(prevChars => {
                prevChars.forEach(char => {
                    if (idsToRemove.has(char.id) && char.imagePreview) {
                        URL.revokeObjectURL(char.imagePreview);
                    }
                });
                return prevChars.filter(char => !idsToRemove.has(char.id));
            });
        }
        return prev.filter(item => item.id !== id);
    });
};

  const handleVideoStateChangeFromUploaded = (id: string, index: number, changes: Partial<VideoState>) => {
    setUploadedItems(prev => prev.map(item => {
        if (item.id !== id) return item;
        const newVideoStates = [...item.videoStates];
        if (newVideoStates[index]) {
            newVideoStates[index] = { ...newVideoStates[index], ...changes };
        }
        return { ...item, videoStates: newVideoStates };
    }));
  };
  
  const handleConfirmGenerateVideoFromUploaded = async (id: string, scene: StoryboardScene, index: number) => {
    const uploadedItem = uploadedItems.find(item => item.id === id);
    if (!uploadedItem) return;
    const { generationItem, videoStates } = uploadedItem;
    const videoState = videoStates[index];

    handleVideoStateChangeFromUploaded(id, index, { status: 'loading', error: null, showScriptInput: false, loadingMessage: 'Initializing video generation...' });
    
    try {
      if (typeof window !== 'undefined' && window.aistudio && typeof window.aistudio.hasSelectedApiKey === 'function' && typeof window.aistudio.openSelectKey === 'function') {
        if (!await window.aistudio.hasSelectedApiKey()) {
          await window.aistudio.openSelectKey();
        }
      }
      let audioOptions: AudioOptions | null = null;
      if (audioAssignment?.file && audioAssignment.assignment) {
          const assignedChar = characters.find(c => c.id === (audioAssignment.assignment as any).characterId);
          audioOptions = {
              mode: 'upload',
              data: await fileToBase64(audioAssignment.file),
              mimeType: audioAssignment.file.type,
              assignment: audioAssignment.assignment.type === 'character' && assignedChar
                  ? { type: 'character', characterName: assignedChar.name }
                  : { type: 'background' }
          };
      } else if (videoState.voiceoverMode === 'upload' && videoState.voiceoverFile) { 
          audioOptions = { mode: 'upload', data: await fileToBase64(videoState.voiceoverFile), mimeType: videoState.voiceoverFile.type }; 
      } else if (videoState.voiceoverMode === 'tts' && videoState.scriptPrompt) { 
          audioOptions = { mode: 'tts', data: videoState.scriptPrompt }; 
      }
      
      const { videoUrl, audioUrl, videoObject, audioBase64 } = await generateVideoFromScene(
        scene, generationItem.aspectRatio, videoState.scriptPrompt, generationItem.characters, audioOptions, generationItem.imageStyle, 
        videoModel, videoResolution, videoState.cameraMovement,
        (message) => handleVideoStateChangeFromUploaded(id, index, { loadingMessage: message })
      );
      handleVideoStateChangeFromUploaded(id, index, { status: 'success', clips: [{ videoUrl, audioUrl, videoObject, audioBase64 }], currentClipIndex: 0 });
    } catch (err) {
        await handleVideoGenerationError(err, (changes) => handleVideoStateChangeFromUploaded(id, index, changes), "Video generation from uploaded item failed:");
    }
  };

  const handleEditUploadedImage = async (id: string, sceneIndex: number, editPrompt: string) => {
    const uploadedItem = uploadedItems.find(item => item.id === id);
    if (!uploadedItem) return;

    const sceneToEdit = uploadedItem.generationItem.imageSet[sceneIndex];
    if (!sceneToEdit || !sceneToEdit.src) return;

    const newPreviousSrc = sceneToEdit.src;

    setUploadedItems(prev => prev.map(item => {
        if (item.id !== id) return item;
        const updatedImageSet: AppStoryboardScene[] = item.generationItem.imageSet.map((s, i) => i === sceneIndex ? { ...s, isEditing: true, previousSrc: newPreviousSrc } : s);
        return { ...item, generationItem: { ...item.generationItem, imageSet: updatedImageSet } };
    }));

    try {
        const { src: newImageSrc, error: newImageError } = await editImage({
            imageBase64: sceneToEdit.src, mimeType: uploadedItem.mimeType, editPrompt,
            aspectRatio: uploadedItem.generationItem.aspectRatio, imageStyle: uploadedItem.generationItem.imageStyle,
            genre: uploadedItem.generationItem.genre, characters: uploadedItem.generationItem.characters,
        });

        setUploadedItems(prev => prev.map(item => {
            if (item.id !== id) return item;
            const updatedImageSet: AppStoryboardScene[] = item.generationItem.imageSet.map((s, i) => i === sceneIndex ? { ...s, src: newImageSrc, error: newImageError, isEditing: false } : s);
            return { ...item, generationItem: { ...item.generationItem, imageSet: updatedImageSet } };
        }));
    } catch (error) {
        const parsedError = parseErrorMessage(error);
        setUploadedItems(prev => prev.map(item => {
            if (item.id !== id) return item;
            const updatedImageSet: AppStoryboardScene[] = item.generationItem.imageSet.map((s, i) => i === sceneIndex ? { ...s, error: parsedError, isEditing: false } : s);
            return { ...item, generationItem: { ...item.generationItem, imageSet: updatedImageSet } };
        }));
    }
};

const handleUndoEditForUploaded = (id: string, sceneIndex: number) => {
    setUploadedItems(prev => prev.map(item => {
        if (item.id !== id) return item;
        const newImageSet = item.generationItem.imageSet.map((s, i) => {
            if (i === sceneIndex && s.previousSrc) {
                return { ...s, src: s.previousSrc, previousSrc: null };
            }
            return s;
        });
        return { ...item, generationItem: { ...item.generationItem, imageSet: newImageSet } };
    }));
};

const handleToggleSaveUploadedItem = useCallback(async (id: string, sceneIndex: number) => {
    const uploadedItem = uploadedItems.find(item => item.id === id);
    if (!uploadedItem) return;
    const scene = uploadedItem.generationItem.imageSet[sceneIndex];
    if (!scene || !scene.src) return;

    const videoState = uploadedItem.videoStates[sceneIndex];
    const itemId = `${uploadedItem.id}-${sceneIndex}`;
    const isAlreadySaved = savedItems.some(item => item.id === itemId);

    let newItems;
    if (isAlreadySaved) {
        newItems = savedItems.filter(item => item.id !== itemId);
    } else {
        const serializableVideoState = {
            ...videoState,
            voiceoverFile: null,
        };
        const newItem: SavedItem = {
            id: itemId, scene: scene,
            videoState: serializableVideoState,
            originalPrompt: uploadedItem.generationItem.prompt, aspectRatio: uploadedItem.generationItem.aspectRatio,
            imageStyle: uploadedItem.generationItem.imageStyle, imageModel: uploadedItem.generationItem.imageModel,
            genre: uploadedItem.generationItem.genre, characters: JSON.parse(JSON.stringify(uploadedItem.generationItem.characters)),
            expiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
        };
        newItems = [newItem, ...savedItems];
    }
    await saveItems(newItems);
    setSavedItems(newItems);
}, [savedItems, uploadedItems]);

const handleDeleteClipForUploaded = (id: string, sceneIndex: number, clipIndex: number) => {
    setUploadedItems(prev => prev.map(item => {
        if (item.id !== id) return item;

        const newVideoStates = [...item.videoStates];
        const currentVideoState = newVideoStates[sceneIndex];

        if (currentVideoState && currentVideoState.clips.length > clipIndex) {
            const newClips = currentVideoState.clips.filter((_, index) => index !== clipIndex);

            if (newClips.length === 0) {
                newVideoStates[sceneIndex] = getInitialVideoState();
            } else {
                let newClipIndex = currentVideoState.currentClipIndex;
                if (newClipIndex >= newClips.length) {
                    newClipIndex = newClips.length - 1;
                }
                if (newClipIndex < 0) {
                    newClipIndex = 0;
                }
                newVideoStates[sceneIndex] = {
                    ...currentVideoState,
                    clips: newClips,
                    currentClipIndex: newClipIndex,
                };
            }
        }
        return { ...item, videoStates: newVideoStates };
    }));
};

const handleDeleteScene = (generationId: number, sceneIndex: number) => {
    setGenerationHistory(prev => {
        const historyCopy = [...prev];
        const itemIndex = historyCopy.findIndex(item => item.id === generationId);
        if (itemIndex === -1) return prev;

        const item = { ...historyCopy[itemIndex] };
        const sceneToDelete = item.imageSet[sceneIndex];
        if (!sceneToDelete) return prev;

        const isParent = sceneToDelete.isCameraAngleFor === undefined;
        let confirmMessage = 'Are you sure you want to delete this scene? This action cannot be undone.';
        const initialIndicesToRemove = new Set<number>([sceneIndex]);

        if (isParent) {
            const childrenCount = item.imageSet.filter(s => s.isCameraAngleFor === sceneIndex).length;
            if (childrenCount > 0) {
                confirmMessage = `This will also delete ${childrenCount} associated camera angle(s). Are you sure?`;
            }
        } else if (sceneToDelete.isCameraAngleFor !== undefined) {
            const parentIndex = sceneToDelete.isCameraAngleFor;
            const siblingCount = item.imageSet.filter(s => s.isCameraAngleFor === parentIndex).length;
            if (siblingCount === 1) { // This is the last child
                confirmMessage = 'This is the last camera angle. Deleting it will also remove the parent scene. Are you sure?';
                initialIndicesToRemove.add(parentIndex); 
            }
        }
        
        if (!window.confirm(confirmMessage)) return prev;

        const finalIndicesToRemove = new Set(initialIndicesToRemove);
        initialIndicesToRemove.forEach(index => {
            if (item.imageSet[index]?.isCameraAngleFor === undefined) {
                item.imageSet.forEach((scene, childIndex) => {
                    if (scene.isCameraAngleFor === index) {
                        finalIndicesToRemove.add(childIndex);
                    }
                });
            }
        });
        
        const oldImageSet = item.imageSet;
        const newImageSet: AppStoryboardScene[] = [];
        const newVideoStates: VideoState[] = [];
        const indexMap: { [oldIndex: number]: number } = {};

        let currentNewIndex = 0;
        for (let i = 0; i < oldImageSet.length; i++) {
            if (!finalIndicesToRemove.has(i)) {
                indexMap[i] = currentNewIndex;
                newImageSet.push(oldImageSet[i]);
                newVideoStates.push(item.videoStates[i]);
                currentNewIndex++;
            }
        }

        const reindexedImageSet = newImageSet.map(scene => {
            if (scene.isCameraAngleFor !== undefined) {
                const oldParentIndex = scene.isCameraAngleFor;
                if (finalIndicesToRemove.has(oldParentIndex)) return { ...scene, isCameraAngleFor: undefined }; 
                const newParentIndex = indexMap[oldParentIndex];
                if (newParentIndex !== undefined) return { ...scene, isCameraAngleFor: newParentIndex };
            }
            return scene;
        });
        
        item.imageSet = reindexedImageSet;
        item.videoStates = newVideoStates;

        if (item.imageSet.length === 0) {
            historyCopy.splice(itemIndex, 1);
        } else {
            historyCopy[itemIndex] = item;
        }
        
        return historyCopy;
    });
};
    
const handleDeleteSceneForUploaded = (id: string, sceneIndex: number) => {
    setUploadedItems(prev => {
        const itemsCopy = [...prev];
        const itemIndex = itemsCopy.findIndex(item => item.id === id);
        if (itemIndex === -1) return prev;

        const item = { ...itemsCopy[itemIndex] };
        const sceneToDelete = item.generationItem.imageSet[sceneIndex];
        if (!sceneToDelete) return prev;

        const isParent = sceneToDelete.isCameraAngleFor === undefined;
        let confirmMessage = 'Are you sure you want to delete this scene? This action cannot be undone.';
        const initialIndicesToRemove = new Set<number>([sceneIndex]);

        if (isParent) {
            const childrenCount = item.generationItem.imageSet.filter(s => s.isCameraAngleFor === sceneIndex).length;
            if (childrenCount > 0) {
                confirmMessage = `This will also delete ${childrenCount} associated camera angle(s). Are you sure?`;
            }
        } else if (sceneToDelete.isCameraAngleFor !== undefined) {
            const parentIndex = sceneToDelete.isCameraAngleFor;
            const siblingCount = item.generationItem.imageSet.filter(s => s.isCameraAngleFor === parentIndex).length;
            if (siblingCount === 1) { // This is the last child
                confirmMessage = 'This is the last camera angle. Deleting it will also remove the parent scene. Are you sure?';
                initialIndicesToRemove.add(parentIndex);
            }
        }

        if (!window.confirm(confirmMessage)) return prev;

        const finalIndicesToRemove = new Set(initialIndicesToRemove);
        initialIndicesToRemove.forEach(index => {
            if (item.generationItem.imageSet[index]?.isCameraAngleFor === undefined) {
                item.generationItem.imageSet.forEach((scene, childIndex) => {
                    if (scene.isCameraAngleFor === index) finalIndicesToRemove.add(childIndex);
                });
            }
        });

        const oldImageSet = item.generationItem.imageSet;
        const newImageSet: AppStoryboardScene[] = [];
        const newVideoStates: VideoState[] = [];
        const indexMap: { [oldIndex: number]: number } = {};

        let currentNewIndex = 0;
        for (let i = 0; i < oldImageSet.length; i++) {
            if (!finalIndicesToRemove.has(i)) {
                indexMap[i] = currentNewIndex;
                newImageSet.push(oldImageSet[i]);
                newVideoStates.push(item.videoStates[i]);
                currentNewIndex++;
            }
        }

        const reindexedImageSet = newImageSet.map(scene => {
            if (scene.isCameraAngleFor !== undefined) {
                const oldParentIndex = scene.isCameraAngleFor;
                if (finalIndicesToRemove.has(oldParentIndex)) return { ...scene, isCameraAngleFor: undefined };
                const newParentIndex = indexMap[oldParentIndex];
                if (newParentIndex !== undefined) return { ...scene, isCameraAngleFor: newParentIndex };
            }
            return scene;
        });

        item.generationItem.imageSet = reindexedImageSet;
        item.videoStates = newVideoStates;

        if (item.generationItem.imageSet.length === 0) {
            itemsCopy.splice(itemIndex, 1);
        } else {
            itemsCopy[itemIndex] = item;
        }

        return itemsCopy;
    });
};

const handleExtendFromLastFrame = async (id: number | string, sceneIndex: number, isUploaded: boolean) => {
    const updateFunc = isUploaded ? setUploadedItems : setGenerationHistory;
    let targetItem: GenerationItem | UploadedItem | undefined;

    if (isUploaded) {
        targetItem = uploadedItems.find(item => item.id === id);
    } else {
        targetItem = generationHistory.find(item => item.id === id);
    }

    if (!targetItem) return;

    const videoState = targetItem.videoStates[sceneIndex];
    const lastClip = videoState?.clips[videoState.clips.length - 1];

    if (!lastClip?.videoUrl) {
        alert("No video clip found to extend from.");
        return;
    }

    setAppStatus({ status: 'loading', error: null });
    setLoadingMessage("Extracting last frame...");

    try {
        const frameBase64 = await extractFrameAsBase64(lastClip.videoUrl);
        const newScene: AppStoryboardScene = {
            src: frameBase64,
            prompt: `Animation from the last frame of the previous scene.`,
            isCameraAngleFor: sceneIndex,
        };

        // @ts-ignore
        updateFunc(prev => {
            const updateLogic = (item: GenerationItem | UploadedItem) => {
                const itemId = isUploaded ? (item as UploadedItem).id : (item as GenerationItem).id;
                if (itemId === id) {
                    const sourceImageSet = isUploaded
                        ? (item as UploadedItem).generationItem.imageSet
                        : (item as GenerationItem).imageSet;
                    const newImageSet = [...sourceImageSet];
                    const newVideoStates = [...item.videoStates];

                    const parentIndex = sceneIndex;
                    let lastChildIndex = parentIndex;
                    for (let i = parentIndex + 1; i < newImageSet.length; i++) {
                        if (newImageSet[i].isCameraAngleFor === parentIndex) {
                            lastChildIndex = i;
                        } else {
                            break;
                        }
                    }
                    const insertionPoint = lastChildIndex + 1;
                    
                    newImageSet.splice(insertionPoint, 0, newScene);
                    newVideoStates.splice(insertionPoint, 0, getInitialVideoState());

                    if (isUploaded) {
                        const uploadedItem = item as UploadedItem;
                        return { ...uploadedItem, generationItem: { ...uploadedItem.generationItem, imageSet: newImageSet }, videoStates: newVideoStates };
                    } else {
                         return { ...item, imageSet: newImageSet, videoStates: newVideoStates };
                    }
                }
                return item;
            };

            if (Array.isArray(prev)) {
                return prev.map(updateLogic);
            } else {
                return updateLogic(prev as UploadedItem);
            }
        });

    } catch (error) {
        const message = parseErrorMessage(error);
        setAppStatus({ status: 'error', error: `Failed to create from last frame: ${message}` });
    } finally {
        setAppStatus({ status: 'idle', error: null });
        setLoadingMessage("");
    }
};

  const handleDeleteGeneration = (id: number) => {
    if (window.confirm('Are you sure you want to delete this entire generation result? This action cannot be undone.')) {
      setGenerationHistory(prev => prev.filter(item => item.id !== id));
    }
  };

  const isDisabled = appStatus.status === 'loading' || isGeneratingPrompt;
  const isGenerateDisabled = !promptText || isDisabled || characters.some(c => c.isDescribing);
  const showPromptLoader = isGeneratingPrompt && !promptText;
  
  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 flex flex-col md:flex-row font-sans">
      <div className="w-full md:w-1/3 lg:w-[450px] p-4 bg-gray-800/30 flex flex-col border-b md:border-b-0 md:border-r border-white/10 md:h-screen">
        
        <div className="flex border-b border-gray-700 mb-4">
            <button onClick={() => setActiveTab('controls')} className={`flex-1 font-semibold text-sm p-3 rounded-t-lg transition-colors ${activeTab === 'controls' ? 'bg-gray-700/50 text-white' : 'text-gray-400 hover:bg-gray-800/50'}`}>Controls</button>
            <button onClick={() => setActiveTab('saved')} className={`flex-1 font-semibold text-sm p-3 rounded-t-lg relative transition-colors ${activeTab === 'saved' ? 'bg-gray-700/50 text-white' : 'text-gray-400 hover:bg-gray-800/50'}`}>
                Saved
                {savedItems.length > 0 && <span className="absolute top-2 right-3 w-5 h-5 bg-amber-600 text-white text-[10px] rounded-full flex items-center justify-center font-bold">{savedItems.length}</span>}
            </button>
        </div>

        <div className="flex-grow overflow-y-auto pr-2 -mr-2">
            {activeTab === 'controls' && (
                <div className="space-y-4">
                    <CollapsibleSection title="Core Idea" defaultOpen={true}>
                        <div className="space-y-4 p-2">
                            <div className="flex items-center gap-2">
                                <label htmlFor="audio-upload" className={`flex-grow p-3 text-center rounded-md font-semibold tracking-wide border-2 border-dashed border-gray-600 cursor-pointer transition-colors ${isDisabled ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-900/50 hover:border-indigo-400 hover:text-indigo-300'}`}>
                                    {audioAssignment?.file ? audioAssignment.file.name.substring(0, 25) + (audioAssignment.file.name.length > 25 ? '...' : '') : 'Upload Audio for Inspiration'}
                                </label>
                                <input id="audio-upload" type="file" className="hidden" accept="audio/*" onChange={handleFileChange} disabled={isDisabled}/>
                                {audioAssignment && (
                                    <button 
                                        onClick={handleClearAudio} 
                                        className="p-1 text-gray-500 hover:text-red-400 transition-colors shrink-0 disabled:text-gray-600 disabled:cursor-not-allowed"
                                        disabled={isDisabled}
                                        aria-label="Clear audio file"
                                    >
                                        <XCircleIcon className="w-6 h-6" />
                                    </button>
                                )}
                            </div>
                            
                            {audioAssignment && (
                                <AudioAssignmentManager
                                    assignment={audioAssignment}
                                    onAssign={(newAssignment) => {
                                        setAudioAssignment(prev => prev ? { ...prev, assignment: newAssignment } : null);
                                    }}
                                    isDisabled={isDisabled}
                                />
                            )}

                            <button
                                onClick={() => uploadInputRef.current?.click()}
                                disabled={isDisabled}
                                className={`w-full flex items-center justify-center gap-2 p-3 text-center rounded-md font-semibold tracking-wide border-2 border-dashed border-gray-600 cursor-pointer transition-colors ${isDisabled ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-900/50 hover:border-green-400 hover:text-green-300'}`}
                            >
                                <VideoIcon className="w-5 h-5" /> Animate Custom Image
                            </button>
                            <input ref={uploadInputRef} type="file" className="hidden" accept="image/*" onChange={handleImageUploadForVideo} />


                            <div className="relative flex-grow flex flex-col min-h-[150px]">
                                <textarea value={promptText} onChange={handleTextChange} readOnly={isDisabled} className="w-full flex-grow p-3 bg-gray-900/50 border border-gray-700 rounded-md text-gray-300 text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="Or describe what you want to generate... e.g., 'a friendly robot', 'a mystical forest', 'a sports car'" />
                                {showPromptLoader && (
                                    <div className="absolute inset-0 bg-gray-900/80 flex flex-col items-center justify-center text-center rounded-md">
                                    <LoaderIcon className="w-8 h-8 text-indigo-400 animate-spin" />
                                    <p className="text-sm text-gray-300 mt-2">Analyzing audio...</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </CollapsibleSection>

                    <CollapsibleSection title="Character Definition (Optional)">
                        <div className="p-2">
                          <CharacterManager characters={characters} setCharacters={setCharacters} isDisabled={isDisabled} />
                        </div>
                    </CollapsibleSection>

                    <CollapsibleSection title="Generation Settings">
                        <div className="space-y-4 p-2">
                            <div>
                                <label htmlFor="genre" className="text-sm text-gray-400 font-semibold mb-2 block">Genre</label>
                                <select id="genre" value={genre} onChange={(e) => setGenre(e.target.value)} disabled={isDisabled} className="w-full bg-gray-700 border border-gray-600 text-white text-sm rounded-md p-2 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block appearance-none">
                                    {GENRES.map((g) => (<option key={g} value={g}>{g}</option>))}
                                </select>
                            </div>
                            <div className="w-full">
                                <label htmlFor="image-count" className="text-sm font-semibold text-gray-300 flex justify-between">
                                    <span>Number of Scenes</span>
                                    <span>{imageCount}</span>
                                </label>
                                <input id="image-count" type="range" min="1" max="10" value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 mt-2" disabled={isDisabled}/>
                            </div>
                        </div>
                    </CollapsibleSection>

                    <CollapsibleSection title="Style & Formatting">
                        <div className="space-y-4 p-2">
                            <div>
                                <label htmlFor="image-model" className="text-sm text-gray-400 font-semibold mb-2 block">Image Model</label>
                                <select id="image-model" value={imageModel} onChange={(e) => setImageModel(e.target.value)} disabled={isDisabled} className="w-full bg-gray-700 border border-gray-600 text-white text-sm rounded-md p-2 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block appearance-none">
                                    <option value="imagen-4.0-generate-001">Imagen 4 (High Quality)</option>
                                    <option value="gemini-2.5-flash-image">Nano Banana (Fast)</option>
                                </select>
                            </div>
                            <div>
                                <label htmlFor="image-style" className="text-sm text-gray-400 font-semibold mb-2 block">Image Style</label>
                                <select id="image-style" value={imageStyle} onChange={(e) => setImageStyle(e.target.value)} disabled={isDisabled} className="w-full bg-gray-700 border border-gray-600 text-white text-sm rounded-md p-2 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block appearance-none">
                                    {IMAGE_STYLES.map((style) => (<option key={style} value={style}>{style}</option>))}
                                </select>
                            </div>
                            <div className="w-full">
                                <label className="text-sm font-semibold text-gray-300 mb-2 block">Aspect Ratio</label>
                                <div className="grid grid-cols-2 gap-2">
                                {ASPECT_RATIOS.map((ratio) => (
                                    <button key={ratio} type="button" onClick={() => setAspectRatio(ratio)} disabled={isDisabled} className={`p-2 text-sm font-semibold rounded-md transition-colors ${ aspectRatio === ratio ? 'bg-indigo-600 text-white shadow-md' : 'bg-gray-700 text-gray-300 hover:bg-gray-600' } disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed`}>
                                        {ratio}
                                    </button>
                                ))}
                                </div>
                            </div>
                        </div>
                    </CollapsibleSection>

                    <CollapsibleSection title="Video Settings">
                         <div className="space-y-4 p-2">
                            <div>
                                <label htmlFor="video-model" className="text-sm text-gray-400 font-semibold mb-2 block">Video Model</label>
                                <select id="video-model" value={videoModel} onChange={(e) => setVideoModel(e.target.value)} disabled={isDisabled} className="w-full bg-gray-700 border border-gray-600 text-white text-sm rounded-md p-2 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block appearance-none">
                                    <option value="veo-3.1-fast-generate-preview">Veo (Fast)</option>
                                    <option value="veo-3.1-generate-preview">Veo 2 (High Quality)</option>
                                </select>
                                <p className="text-xs text-gray-500 mt-1">High Quality model may take longer to generate.</p>
                            </div>
                            <div>
                                <label htmlFor="video-resolution" className="text-sm text-gray-400 font-semibold mb-2 block">Resolution</label>
                                <select id="video-resolution" value={videoResolution} onChange={(e) => setVideoResolution(e.target.value as '720p' | '1080p')} disabled={isDisabled} className="w-full bg-gray-700 border border-gray-600 text-white text-sm rounded-md p-2 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 block appearance-none">
                                    <option value="720p">720p</option>
                                    <option value="1080p">1080p</option>
                                </select>
                            </div>
                        </div>
                    </CollapsibleSection>
                </div>
            )}
            {activeTab === 'saved' && (
                <SavedItemsManager savedItems={savedItems} onUnsave={handleUnsaveScene} onSelect={handleSelectSavedItem} />
            )}
        </div>

        <div className="mt-auto pt-4">
            {activeTab === 'controls' && (
              <button
                onClick={handleGenerateImage}
                disabled={isGenerateDisabled}
                className="w-full p-3 font-bold text-lg text-center uppercase tracking-wider rounded-md transition-all duration-300 ease-in-out disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed accent-gradient accent-gradient-hover text-white shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
              >
                {appStatus.status === 'loading' ? 'Generating...' : (
                  <div className="flex items-center justify-center">
                    <SparklesIcon className="w-6 h-6 mr-2" />
                    <span>Generate</span>
                  </div>
                )}
              </button>
            )}
        </div>
      </div>

      <main className="w-full flex-grow p-6 overflow-y-auto md:h-screen">
          <ResultsView
              appStatus={appStatus} 
              history={generationHistory}
              loadingMessage={loadingMessage} 
              savedItems={savedItems}
              uploadedItems={uploadedItems}
              onToggleSave={handleToggleSaveScene}
              onGenerateVideoToggle={handleGenerateVideoToggle}
              onConfirmGenerateVideo={handleConfirmGenerateVideo}
              onExtendFromLastFrame={(id, index) => handleExtendFromLastFrame(id, index, false)}
              onVideoStateChange={handleVideoStateChange}
              onDeleteVideo={handleDeleteVideo}
              onDeleteClip={handleDeleteClip}
              onRegenerateImage={handleRegenerateImage}
              onEditImage={handleEditImage}
              onUndoEdit={handleUndoEdit}
              onHydrateClips={handleHydrateClips}
              onGenerateCameraAngles={handleOpenAngleModal}
              onDeleteScene={handleDeleteScene}
              onDeleteGeneration={handleDeleteGeneration}
              onDeleteUploadedItem={handleDeleteUploadedItem}
              onToggleSaveUploadedItem={handleToggleSaveUploadedItem}
              onGenerateVideoToggleForUploaded={(id, index) => handleVideoStateChangeFromUploaded(id, index, { showScriptInput: !uploadedItems.find(item => item.id === id)?.videoStates[index].showScriptInput })}
              onConfirmGenerateVideoForUploaded={handleConfirmGenerateVideoFromUploaded}
              onExtendFromLastFrameForUploaded={(id, index) => handleExtendFromLastFrame(id, index, true)}
              onVideoStateChangeForUploaded={handleVideoStateChangeFromUploaded}
              onDeleteVideoForUploaded={(id, index) => handleVideoStateChangeFromUploaded(id, index, getInitialVideoState())}
              onDeleteClipForUploaded={handleDeleteClipForUploaded}
              onEditImageForUploaded={handleEditUploadedImage}
              onUndoEditForUploaded={handleUndoEditForUploaded}
              onHydrateClipsForUploaded={(id, index, clips) => handleVideoStateChangeFromUploaded(id, index, { clips })}
              onGenerateCameraAnglesForUploaded={handleOpenAngleModalForUploaded}
              onDeleteSceneForUploaded={handleDeleteSceneForUploaded}
          />
      </main>
      
      <CameraAngleModal 
        isOpen={angleModal.isOpen}
        onClose={() => setAngleModal(prev => ({ ...prev, isOpen: false }))}
        selectedAngles={selectedAngles}
        setSelectedAngles={setSelectedAngles}
        onSubmit={handleConfirmAngleGeneration}
      />
    </div>
  );
}