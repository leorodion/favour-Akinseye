
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      // The result is a data URL: "data:audio/mpeg;base64,..."
      // We only need the base64 part.
      const result = reader.result as string;
      const base64String = result.split(',')[1];
      if (base64String) {
        resolve(base64String);
      } else {
        reject(new Error("Failed to read file as Base64."));
      }
    };
    reader.onerror = (error) => reject(error);
  });
};

export function base64ToBytes(base64: string): Uint8Array {
    const binString = atob(base64);
    const len = binString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
}
