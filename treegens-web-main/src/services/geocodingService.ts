export interface ReverseGeocodeResult {
  success: boolean
  address?: string
  shortAddress?: string
  /** ISO 3166-1 alpha-2, upper case, when Nominatim returns address details */
  countryCode?: string
  error?: string
}

export interface GeocodeOptions {
  zoom?: number
  addressDetails?: boolean
  language?: string
  format?: 'json' | 'xml'
}

/** A failed lookup (network, rate limit) is retried after this long. */
const FAILURE_RETRY_MS = 60_000

class GeocodingService {
  private cache = new Map<string, ReverseGeocodeResult>()
  /** When each failed lookup may be tried again */
  private failedUntil = new Map<string, number>()
  private readonly baseUrl = 'https://nominatim.openstreetmap.org'

  /**
   * Reverse geocode coordinates to human-readable address
   * @param latitude - GPS latitude coordinate
   * @param longitude - GPS longitude coordinate
   * @param options - Geocoding options
   * @returns Promise with geocoding result
   */
  async reverseGeocode(
    latitude: number,
    longitude: number,
    options: GeocodeOptions = {},
  ): Promise<ReverseGeocodeResult> {
    // Input validation
    if (!this.isValidCoordinate(latitude, longitude)) {
      return {
        success: false,
        error: 'Invalid coordinates provided',
      }
    }

    // Create cache key
    const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const retryAt = this.failedUntil.get(cacheKey)
      if (retryAt === undefined || Date.now() < retryAt) {
        console.log('🗂️ Using cached geocoding result')
        return this.cache.get(cacheKey)!
      }
      this.cache.delete(cacheKey)
      this.failedUntil.delete(cacheKey)
    }

    const defaultOptions: GeocodeOptions = {
      zoom: 18,
      addressDetails: true,
      language: 'en',
      format: 'json',
      ...options,
    }

    try {
      const url = this.buildReverseGeocodeUrl(
        latitude,
        longitude,
        defaultOptions,
      )

      console.log('🌐 Fetching address for coordinates:', latitude, longitude)

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'TreeGens-Frontend/1.0', // Required by Nominatim
        },
      })

      if (!response.ok) {
        throw new Error(`Geocoding API returned ${response.status}`)
      }

      const data = await response.json()

      if (!data.display_name) {
        const result: ReverseGeocodeResult = {
          success: false,
          error: 'No address found for coordinates',
        }
        this.cache.set(cacheKey, result)
        return result
      }

      const result: ReverseGeocodeResult = {
        success: true,
        address: data.display_name,
        shortAddress: this.extractShortAddress(data.display_name),
        countryCode: this.extractCountryCode(data),
      }

      // Cache the result
      this.cache.set(cacheKey, result)

      console.log('✅ Geocoding successful:', result.shortAddress)
      return result
    } catch (error) {
      console.warn('❌ Reverse geocoding failed:', error)

      const result: ReverseGeocodeResult = {
        success: false,
        error:
          error instanceof Error ? error.message : 'Unknown geocoding error',
      }

      // Cache failed results for a short time to avoid repeated requests
      this.cache.set(cacheKey, result)
      this.failedUntil.set(cacheKey, Date.now() + FAILURE_RETRY_MS)
      return result
    }
  }

  /**
   * Get coordinates from address (forward geocoding)
   * @param address - Address to geocode
   * @returns Promise with coordinates
   */
  async forwardGeocode(address: string): Promise<{
    success: boolean
    latitude?: number
    longitude?: number
    error?: string
  }> {
    if (!address.trim()) {
      return { success: false, error: 'Address is required' }
    }

    try {
      const url = `${this.baseUrl}/search?format=json&q=${encodeURIComponent(address)}&limit=1`

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'TreeGens-Frontend/1.0',
        },
      })

      if (!response.ok) {
        throw new Error(`Geocoding API returned ${response.status}`)
      }

      const data = await response.json()

      if (!data.length) {
        return { success: false, error: 'Address not found' }
      }

      return {
        success: true,
        latitude: parseFloat(data[0].lat),
        longitude: parseFloat(data[0].lon),
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Unknown geocoding error',
      }
    }
  }

  /**
   * Clear the geocoding cache
   */
  clearCache(): void {
    this.cache.clear()
    this.failedUntil.clear()
    console.log('🗑️ Geocoding cache cleared')
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    }
  }

  private isValidCoordinate(lat: number, lng: number): boolean {
    return (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    )
  }

  private buildReverseGeocodeUrl(
    latitude: number,
    longitude: number,
    options: GeocodeOptions,
  ): string {
    const params = new URLSearchParams({
      format: options.format || 'json',
      lat: latitude.toString(),
      lon: longitude.toString(),
      zoom: (options.zoom || 18).toString(),
      addressdetails: options.addressDetails ? '1' : '0',
      ...(options.language && { 'accept-language': options.language }),
    })

    return `${this.baseUrl}/reverse?${params.toString()}`
  }

  private extractCountryCode(data: {
    address?: { country_code?: unknown }
  }): string | undefined {
    const code = data.address?.country_code
    return typeof code === 'string' && /^[a-z]{2}$/i.test(code)
      ? code.toUpperCase()
      : undefined
  }

  extractShortAddress(fullAddress: string): string {
    if (!fullAddress) return ''

    // Extract meaningful parts (first 3 components typically)
    const parts = fullAddress.split(',').map(part => part.trim())

    // Remove very specific parts like house numbers and postal codes
    const meaningfulParts = parts.filter(part => {
      // Skip if it's just numbers (likely house number or postal code)
      if (/^\d+$/.test(part)) return false
      // Skip very long postal/zip codes
      if (/^\d{5,}/.test(part)) return false
      return true
    })

    // Return first 3 meaningful parts
    return meaningfulParts.slice(0, 3).join(', ')
  }
}

// Export singleton instance
export const geocodingService = new GeocodingService()

// Export commonly used functions as shortcuts
export const reverseGeocode =
  geocodingService.reverseGeocode.bind(geocodingService)
export const forwardGeocode =
  geocodingService.forwardGeocode.bind(geocodingService)
