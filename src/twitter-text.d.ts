declare module "twitter-text" {
  interface ParseResult {
    weightedLength: number;
    valid: boolean;
    permillage: number;
    validRangeStart: number;
    validRangeEnd: number;
    displayRangeStart: number;
    displayRangeEnd: number;
  }
  interface TwitterTextApi {
    parseTweet(text: string, options?: Record<string, unknown>): ParseResult;
    extractUrls(text: string): string[];
    extractUrlsWithIndices(
      text: string,
    ): Array<{ url: string; indices: [number, number] }>;
  }
  const twitterText: TwitterTextApi;
  export default twitterText;
}
