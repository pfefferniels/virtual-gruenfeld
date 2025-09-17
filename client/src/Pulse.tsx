import { styled } from "@mui/material/styles";
import { keyframes } from "@mui/system";
import Mic from "@mui/icons-material/Mic";

const pulse = keyframes`
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.2); /* adjust intensity */
  }
  100% {
    transform: scale(1);
  }
`;

export const Pulsing = styled("div")({
  animation: `${pulse} 1.5s infinite ease-in-out`,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  transformOrigin: "center center", // 🔑 keeps it from shifting
  willChange: "transform",          // smooth GPU rendering
});
