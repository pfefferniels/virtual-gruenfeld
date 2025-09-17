import { Backdrop, Box, CircularProgress, Typography } from "@mui/material";

interface LoadingOverlayProps {
  open: boolean;
  text?: string;
}

export default function LoadingOverlay({ open, text = "Loading, please wait..." }: LoadingOverlayProps) {
  return (
    <Backdrop
      open={open}
      sx={{
        color: "#fff",
        zIndex: (theme) => theme.zIndex.drawer + 1,
        backgroundColor: "rgba(0,0,0,0.5)",
      }}
    >
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        p={4}
        borderRadius={2}
        boxShadow={3}
        bgcolor='white'
      >
        <CircularProgress />

        <Typography variant="h6" mt={2} color="textPrimary">
          {text}
        </Typography>
      </Box>
    </Backdrop>
  );
}
