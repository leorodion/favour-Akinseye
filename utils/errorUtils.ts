
export function parseErrorMessage(error: unknown): string {
    const defaultMessage = 'An unexpected error occurred. Please check the console for details.';
    if (!(error instanceof Error)) {
        return defaultMessage;
    }

    // Gemini API often returns a JSON string in the error message
    try {
        const parsed = JSON.parse(error.message);
        if (parsed.error && parsed.error.message) {
            // Prepend a user-friendly message if it's a quota issue.
            if (typeof parsed.error.message === 'string' && parsed.error.message.toLowerCase().includes('quota')) {
                return `Quota exceeded. ${parsed.error.message}`;
            }
            return parsed.error.message;
        }
    } catch (e) {
        // Not a JSON string, proceed with string matching on the original message.
    }

    const errorMessage = error.message.toLowerCase();

    if (errorMessage.includes('api key not valid')) {
        return 'Invalid API Key. Please ensure your API key is correct and has the necessary permissions.';
    }
    if (errorMessage.includes('blocked') || errorMessage.includes('safety')) {
        return 'Your prompt was blocked due to the content policy. Please modify your prompt and try again.';
    }
    if (errorMessage.includes('429') || errorMessage.includes('resource_exhausted') || errorMessage.includes('rate limit')) {
        return "You've exceeded your quota. Please check your plan and billing details, then try again.";
    }
    if (errorMessage.includes('503') || errorMessage.includes('unavailable') || errorMessage.includes('overloaded')) {
        return 'The model is temporarily unavailable or overloaded. Please try again later.';
    }
    if (errorMessage.includes("requested entity was not found")) {
        return "API Key error. The selected API key may not have access to this model. Please try selecting your key again.";
    }
    
    // Keep the original message if it's none of the above but still informative.
    return error.message || defaultMessage;
}