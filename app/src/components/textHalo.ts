/**
 * Daylight text-halo for the AR labels + status strip (a 1px dark shadow that keeps callsigns legible
 * over a bright-sky camera preview). react-native-web 0.21 deprecated the `textShadow*` longhand in
 * favour of the CSS `textShadow` shorthand, but native RN 0.86 only supports the longhand — so emit
 * the right form per platform. Both render the same halo; this is the single source for it.
 */
import { Platform, type TextStyle } from "react-native";

export const textHalo: TextStyle =
  Platform.OS === "web"
    ? // rn-web wants the CSS shorthand (offset-x offset-y blur colour); it isn't in RN's TextStyle type.
      ({ textShadow: "0px 1px 2px rgba(0, 0, 0, 0.9)" } as unknown as TextStyle)
    : {
        textShadowColor: "rgba(0, 0, 0, 0.9)",
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 2,
      };
