import React, { useState, useEffect } from 'react';
import {
  Box,
  Container,
  CssBaseline,
  ThemeProvider,
  createTheme,
  AppBar,
  Toolbar,
  Typography,
  Tabs,
  Tab,
  Paper,
  Button,
  Menu,
  MenuItem,
} from '@mui/material';
import {
  PhoneInTalk as PhoneInTalkIcon,
  AccountCircle as AccountCircleIcon,
  ExitToApp as LogoutIcon,
} from '@mui/icons-material';

// Import components
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import AgentControl from './components/AgentControl';
import CallMonitor from './components/CallMonitor';

// Create theme
const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
  },
});

function TabPanel({ children, value, index, ...other }) {
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`tabpanel-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

function App() {
  const [currentTab, setCurrentTab] = useState(0);
  const [wsConnection, setWsConnection] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [anchorEl, setAnchorEl] = useState(null);
  const wsRef = React.useRef(null);

  // Check authentication on mount
  useEffect(() => {
    const authStatus = localStorage.getItem('isAuthenticated');
    const savedUsername = localStorage.getItem('username');
    if (authStatus === 'true' && savedUsername) {
      setIsAuthenticated(true);
      setUsername(savedUsername);
    }
  }, []);

  useEffect(() => {
    // Prevent duplicate WebSocket connections (React 18 StrictMode causes effects to run twice)
    if (wsRef.current) {
      console.log('⚠️  WebSocket already exists, skipping duplicate connection');
      return;
    }

    // Initialize WebSocket connection
    const ws = new WebSocket(
      `ws://${process.env.REACT_APP_BACKEND_HOST || 'localhost:3000'}/ws`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket connected');
      setWsConnection(ws);
    };

    ws.onclose = () => {
      console.log('❌ WebSocket disconnected');
      setWsConnection(null);
      wsRef.current = null;
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('🔌 Closing WebSocket connection...');
        ws.close();
      }
      wsRef.current = null;
    };
  }, []);

  const handleTabChange = (event, newValue) => {
    setCurrentTab(newValue);
  };

  const handleLogin = () => {
    const savedUsername = localStorage.getItem('username');
    setIsAuthenticated(true);
    setUsername(savedUsername || 'root');
  };

  const handleLogout = () => {
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('username');
    localStorage.removeItem('loginTime');
    setIsAuthenticated(false);
    setUsername('');
    handleMenuClose();
    if (wsConnection) {
      wsConnection.close();
    }
  };

  const handleMenuOpen = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Login onLogin={handleLogin} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        {/* Header */}
        <AppBar position="static">
          <Toolbar>
            <PhoneInTalkIcon sx={{ mr: 2 }} />
            <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
              Voice AI Agent Dashboard
            </Typography>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                bgcolor: wsConnection ? '#4caf50' : '#f44336',
                mr: 1
              }}
            />
            <Typography variant="body2" sx={{ mr: 2 }}>
              {wsConnection ? 'Connected' : 'Disconnected'}
            </Typography>
            <Button
              color="inherit"
              startIcon={<AccountCircleIcon />}
              onClick={handleMenuOpen}
              sx={{ textTransform: 'none' }}
            >
              {username}
            </Button>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={handleMenuClose}
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'right',
              }}
              transformOrigin={{
                vertical: 'top',
                horizontal: 'right',
              }}
            >
              <MenuItem disabled>
                <AccountCircleIcon sx={{ mr: 1 }} fontSize="small" />
                Logged in as: {username}
              </MenuItem>
              <MenuItem onClick={handleLogout}>
                <LogoutIcon sx={{ mr: 1 }} fontSize="small" />
                Logout
              </MenuItem>
            </Menu>
          </Toolbar>
        </AppBar>

        {/* Navigation Tabs */}
        <Paper sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={currentTab} onChange={handleTabChange} centered>
            <Tab label="Dashboard" />
            <Tab label="AI Agent" />
            <Tab label="Call Monitor" />
          </Tabs>
        </Paper>

        {/* Content */}
        <Container maxWidth="xl" sx={{ mt: 4, mb: 4, flex: 1 }}>
          <TabPanel value={currentTab} index={0}>
            <Dashboard wsConnection={wsConnection} />
          </TabPanel>
          <TabPanel value={currentTab} index={1}>
            <AgentControl wsConnection={wsConnection} />
          </TabPanel>
          <TabPanel value={currentTab} index={2}>
            <CallMonitor wsConnection={wsConnection} />
          </TabPanel>
        </Container>

        {/* Footer */}
        <Box
          component="footer"
          sx={{
            py: 2,
            px: 2,
            mt: 'auto',
            backgroundColor: (theme) =>
              theme.palette.mode === 'light'
                ? theme.palette.grey[200]
                : theme.palette.grey[800],
          }}
        >
          <Container maxWidth="xl">
            <Typography variant="body2" color="text.secondary" align="center">
              Voice AI Agent © 2024 - Powered by Telnyx & OpenAI
            </Typography>
          </Container>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

export default App;

