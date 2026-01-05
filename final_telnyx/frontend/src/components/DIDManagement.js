import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  Chip,
  Switch,
  FormControlLabel,
  Alert,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItem,
  ListItemText,
  IconButton,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { didAPI } from '../services/api';

function DIDManagement() {
  const [purchasedNumbers, setPurchasedNumbers] = useState([]);
  const [rotation, setRotation] = useState({
    enabled: false,
    allNumbers: [],
    numbersByState: {},
    numbersByAreaCode: {},
    strategy: 'area_code',
    currentIndex: 0,
  });
  const [alert, setAlert] = useState(null);
  const [openSearchDialog, setOpenSearchDialog] = useState(false);
  const [availableNumbers, setAvailableNumbers] = useState([]);
  const [areaCode, setAreaCode] = useState('');

  useEffect(() => {
    fetchPurchasedNumbers();
    fetchRotation();
  }, []);

  const fetchPurchasedNumbers = async () => {
    try {
      const response = await didAPI.getPurchased();
      setPurchasedNumbers(response.data.data);
    } catch (error) {
      showAlert('error', 'Failed to fetch purchased numbers');
    }
  };

  const fetchRotation = async () => {
    try {
      const response = await didAPI.getRotation();
      setRotation(response.data.data);
    } catch (error) {
      showAlert('error', 'Failed to fetch rotation settings');
    }
  };

  const handleToggleRotation = async () => {
    try {
      const response = await didAPI.toggleRotation();
      setRotation(response.data.data);
      showAlert('success', response.data.message);
    } catch (error) {
      showAlert('error', 'Failed to toggle rotation');
    }
  };

  const handleAddToRotation = async (phoneNumber) => {
    try {
      const newNumbers = [...rotation.allNumbers, phoneNumber];
      const response = await didAPI.configureRotation(newNumbers, rotation.enabled, rotation.strategy);
      setRotation(response.data.data);
      showAlert('success', 'Number added to rotation');
    } catch (error) {
      showAlert('error', 'Failed to add number to rotation');
    }
  };

  const handleRemoveFromRotation = async (phoneNumber) => {
    try {
      const newNumbers = rotation.allNumbers.filter(n => n !== phoneNumber);
      const response = await didAPI.configureRotation(newNumbers, rotation.enabled, rotation.strategy);
      setRotation(response.data.data);
      showAlert('success', 'Number removed from rotation');
    } catch (error) {
      showAlert('error', 'Failed to remove number from rotation');
    }
  };

  const handleSearchNumbers = async () => {
    try {
      const response = await didAPI.getAvailable(areaCode || undefined);
      setAvailableNumbers(response.data.data);
      setOpenSearchDialog(true);
    } catch (error) {
      showAlert('error', 'Failed to search available numbers');
    }
  };

  const handlePurchaseNumber = async (phoneNumber) => {
    try {
      await didAPI.purchase(phoneNumber);
      showAlert('success', 'Number purchased successfully');
      setOpenSearchDialog(false);
      fetchPurchasedNumbers();
    } catch (error) {
      showAlert('error', 'Failed to purchase number');
    }
  };

  const showAlert = (severity, message) => {
    setAlert({ severity, message });
    setTimeout(() => setAlert(null), 5000);
  };

  const isInRotation = (phoneNumber) => {
    return rotation.allNumbers && rotation.allNumbers.includes(phoneNumber);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h4">DID Management</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleSearchNumbers}
        >
          Purchase Number
        </Button>
      </Box>

      {alert && (
        <Alert severity={alert.severity} sx={{ mb: 2 }} onClose={() => setAlert(null)}>
          {alert.message}
        </Alert>
      )}

      {/* Rotation Settings */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box>
            <Typography variant="h6" gutterBottom>
              DID Rotation
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Automatically rotate through multiple phone numbers when making calls
            </Typography>
          </Box>
          <FormControlLabel
            control={
              <Switch
                checked={rotation.enabled}
                onChange={handleToggleRotation}
                color="primary"
              />
            }
            label={rotation.enabled ? 'Enabled' : 'Disabled'}
          />
        </Box>

        {rotation.allNumbers && rotation.allNumbers.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="subtitle2">
                Numbers in Rotation ({rotation.allNumbers.length}):
              </Typography>
              <Chip 
                label={`Strategy: ${rotation.strategy === 'area_code' ? 'Area Code Match' : 'Round Robin'}`}
                size="small"
                color="info"
              />
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
              {rotation.allNumbers.map((number, index) => (
                <Chip
                  key={number}
                  label={`${number} ${index === rotation.currentIndex ? '(current)' : ''}`}
                  onDelete={() => handleRemoveFromRotation(number)}
                  color={index === rotation.currentIndex ? 'primary' : 'default'}
                />
              ))}
            </Box>
            <Box sx={{ mt: 2, p: 2, bgcolor: '#f5f5f5', borderRadius: 1 }}>
              <Typography variant="caption" color="textSecondary">
                📍 States Covered: {Object.keys(rotation.numbersByState || {}).length} | 
                Area Codes: {Object.keys(rotation.numbersByAreaCode || {}).length}
              </Typography>
              <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {Object.entries(rotation.numbersByState || {}).map(([state, numbers]) => (
                  <Chip 
                    key={state} 
                    label={`${state} (${numbers.length})`} 
                    size="small" 
                    variant="outlined"
                  />
                ))}
              </Box>
            </Box>
          </Box>
        )}
      </Paper>

      {/* Purchased Numbers */}
      <Paper sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Purchased Phone Numbers</Typography>
          <IconButton onClick={fetchPurchasedNumbers}>
            <RefreshIcon />
          </IconButton>
        </Box>

        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Phone Number</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Connection</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {purchasedNumbers.map((number) => (
                <TableRow key={number.id}>
                  <TableCell>
                    <Typography variant="body2" fontWeight="medium">
                      {number.phone_number}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={number.status}
                      size="small"
                      color={number.status === 'active' ? 'success' : 'default'}
                    />
                  </TableCell>
                  <TableCell>{number.connection_name || 'Not connected'}</TableCell>
                  <TableCell align="right">
                    {isInRotation(number.phone_number) ? (
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        onClick={() => handleRemoveFromRotation(number.phone_number)}
                      >
                        Remove from Rotation
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => handleAddToRotation(number.phone_number)}
                      >
                        Add to Rotation
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Search Numbers Dialog */}
      <Dialog
        open={openSearchDialog}
        onClose={() => setOpenSearchDialog(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Search & Purchase Phone Numbers</DialogTitle>
        <DialogContent>
          <Box sx={{ mb: 2, mt: 1 }}>
            <TextField
              label="Area Code (optional)"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value)}
              placeholder="e.g., 212"
              fullWidth
            />
            <Button
              variant="contained"
              onClick={handleSearchNumbers}
              sx={{ mt: 1 }}
              fullWidth
            >
              Search
            </Button>
          </Box>

          {availableNumbers.length > 0 && (
            <List>
              {availableNumbers.slice(0, 20).map((number) => (
                <ListItem
                  key={number.phone_number}
                  secondaryAction={
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => handlePurchaseNumber(number.phone_number)}
                    >
                      Purchase
                    </Button>
                  }
                >
                  <ListItemText
                    primary={number.phone_number}
                    secondary={`${number.region_information?.[0]?.region_name || 'Unknown'} - $${number.cost_information?.upfront_cost || '0'}/mo`}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenSearchDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default DIDManagement;

