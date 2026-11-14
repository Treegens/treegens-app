import { Link2, MapPin, MessageCircleQuestion, Phone, PhoneCall, Video } from 'lucide-react';
import type { LocationType } from '../../../shared/types';

/** The icon that stands for a way of meeting. */
export function LocationIcon({ type, size = 18 }: { type: LocationType; size?: number }) {
  switch (type) {
    case 'google_meet':
      return <Video size={size} aria-hidden="true" />;
    case 'phone_host_calls':
      return <PhoneCall size={size} aria-hidden="true" />;
    case 'phone_invitee_calls':
      return <Phone size={size} aria-hidden="true" />;
    case 'in_person':
      return <MapPin size={size} aria-hidden="true" />;
    case 'custom_link':
      return <Link2 size={size} aria-hidden="true" />;
    default:
      return <MessageCircleQuestion size={size} aria-hidden="true" />;
  }
}
