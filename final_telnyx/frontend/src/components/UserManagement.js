import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  Chip,
  Alert,
  TablePagination,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  CircularProgress,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Upload as UploadIcon,
  Phone as PhoneIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { useDropzone } from 'react-dropzone';
import { usersAPI, callsAPI, didAPI } from '../services/api';
import UserEditDialog from './UserEditDialog';

function UserManagement() {
  const [users, setUsers] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    firstname: '',
    lastname: '',
    phone: '',
    address: '',
    email: '',
    notes: '',
  });
  const [alert, setAlert] = useState(null);
  
  // Pagination and filtering state
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [totalUsers, setTotalUsers] = useState(0);
  const [searchInput, setSearchInput] = useState(''); // User's immediate input
  const [search, setSearch] = useState(''); // Debounced search value for API
  const [statusFilter, setStatusFilter] = useState('');
  const [answerTypeFilter, setAnswerTypeFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleteAllDialogOpen, setDeleteAllDialogOpen] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, [page, rowsPerPage, search, statusFilter, answerTypeFilter]);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await usersAPI.getPaginated(
        page + 1, // API uses 1-based pagination
        rowsPerPage,
        {
          search,
          status: statusFilter,
          answerType: answerTypeFilter
        }
      );
      setUsers(response.data.data);
      setTotalUsers(response.data.pagination.total);
    } catch (error) {
      showAlert('error', 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleSearchChange = (event) => {
    setSearchInput(event.target.value);
  };

  // Debounce search input - wait 500ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 500);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleOpenDialog = (user = null) => {
    if (user) {
      setEditingUser(user);
      setFormData(user);
    } else {
      setEditingUser(null);
      setFormData({
        firstname: '',
        lastname: '',
        phone: '',
        address: '',
        email: '',
        notes: '',
      });
    }
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setEditingUser(null);
  };

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async () => {
    try {
      if (editingUser) {
        await usersAPI.update(editingUser.id, formData);
        showAlert('success', 'User updated successfully');
      } else {
        await usersAPI.create(formData);
        showAlert('success', 'User created successfully');
      }
      handleCloseDialog();
      fetchUsers();
    } catch (error) {
      showAlert('error', 'Failed to save user');
    }
  };

  const handleDelete = async (userId) => {
    if (window.confirm('Are you sure you want to delete this user?')) {
      try {
        await usersAPI.delete(userId);
        showAlert('success', 'User deleted successfully');
        fetchUsers();
      } catch (error) {
        showAlert('error', 'Failed to delete user');
      }
    }
  };

  const handleDeleteAll = async () => {
    try {
      const response = await usersAPI.deleteAll();
      showAlert('success', `Successfully deleted ${response.data.deletedCount} users`);
      setDeleteAllDialogOpen(false);
      fetchUsers();
    } catch (error) {
      showAlert('error', 'Failed to delete all users');
    }
  };

  const handleCall = async (user) => {
    try {
      // Get a phone number from DID rotation or use first available number
      let fromNumber;
      
      try {
        // Try to get from DID rotation first
        const rotationResponse = await didAPI.getNext();
        fromNumber = rotationResponse.data.data.number;
      } catch (rotationError) {
        // If rotation not enabled, get first purchased number
        const numbersResponse = await didAPI.getPurchased();
        if (numbersResponse.data.data.length === 0) {
          showAlert('error', 'No phone numbers available. Please purchase a number first.');
          return;
        }
        fromNumber = numbersResponse.data.data[0].phone_number;
      }
      
      const response = await callsAPI.initiate(user.id, fromNumber);
      showAlert('success', `Call initiated to ${user.firstname} ${user.lastname} from ${fromNumber}`);
    } catch (error) {
      console.error('Call error:', error);
      showAlert('error', error.response?.data?.error || 'Failed to initiate call');
    }
  };

  const onDrop = async (acceptedFiles) => {
    const file = acceptedFiles[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await usersAPI.import(formData);
      showAlert('success', `Imported ${response.data.data.length} users successfully`);
      fetchUsers();
    } catch (error) {
      showAlert('error', 'Failed to import CSV');
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
    },
    multiple: false,
  });

  const showAlert = (severity, message) => {
    setAlert({ severity, message });
    setTimeout(() => setAlert(null), 5000);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending':
        return 'default';
      case 'called':
        return 'primary';
      case 'qualified':
        return 'success';
      case 'disqualified':
        return 'error';
      default:
        return 'default';
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h4">User Management ({totalUsers} total)</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => handleOpenDialog()}
          >
            Add User
          </Button>
          <Button
            variant="outlined"
            startIcon={<UploadIcon />}
            component="label"
          >
            Import CSVs
            <input
              type="file"
              hidden
              accept=".csv"
              onChange={(e) => {
                const files = e.target.files;
                if (files) onDrop(Array.from(files));
              }}
            />
          </Button>
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={() => setDeleteAllDialogOpen(true)}
          >
            Delete All Users
          </Button>
        </Box>
      </Box>

      {alert && (
        <Alert severity={alert.severity} sx={{ mb: 2 }} onClose={() => setAlert(null)}>
          {alert.message}
        </Alert>
      )}

      {/* Search and Filters */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            placeholder="Search by name, phone, or email..."
            value={searchInput}
            onChange={handleSearchChange}
            variant="outlined"
            size="small"
            sx={{ flexGrow: 1, minWidth: 250 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
            }}
          />
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Status</InputLabel>
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(0);
              }}
              label="Status"
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="called">Called</MenuItem>
              <MenuItem value="qualified">Qualified</MenuItem>
              <MenuItem value="disqualified">Disqualified</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Answer Type</InputLabel>
            <Select
              value={answerTypeFilter}
              onChange={(e) => {
                setAnswerTypeFilter(e.target.value);
                setPage(0);
              }}
              label="Answer Type"
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="answered">Answered</MenuItem>
              <MenuItem value="voicemail">Voicemail</MenuItem>
              <MenuItem value="no_answer">No Answer</MenuItem>
              <MenuItem value="not_found">Not Found</MenuItem>
              <MenuItem value="busy">Busy</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Paper>

      {/* CSV Drop Zone */}
      <Paper
        {...getRootProps()}
        sx={{
          p: 3,
          mb: 3,
          textAlign: 'center',
          border: '2px dashed',
          borderColor: isDragActive ? 'primary.main' : 'grey.300',
          backgroundColor: isDragActive ? 'action.hover' : 'background.paper',
          cursor: 'pointer',
        }}
      >
        <input {...getInputProps()} />
        <UploadIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
        <Typography>
          {isDragActive
            ? 'Drop the CSV file here...'
            : 'Drag & drop a CSV file here, or click to select'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          CSV format: firstname, lastname, phone, address, state (optional: email, notes)
        </Typography>
      </Paper>

      {/* Users Table */}
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell width="50">No</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Phone</TableCell>
              <TableCell>Address</TableCell>
              <TableCell>DID Number</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 5 }}>
                  <CircularProgress />
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 5 }}>
                  <Typography color="text.secondary">
                    No users found. Import a CSV or add users manually.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              users.map((user, index) => (
                <TableRow key={user.id}>
                  <TableCell>{page * rowsPerPage + index + 1}</TableCell>
                  <TableCell>
                    <Typography variant="body2" fontWeight="medium">
                      {user.firstname} {user.lastname}
                    </Typography>
                  </TableCell>
                  <TableCell>{user.phone}</TableCell>
                  <TableCell>{user.address}</TableCell>
                  <TableCell>
                    {user.didNumber ? (
                      <Chip 
                        label={user.didNumber} 
                        size="small" 
                        variant="outlined"
                        color="primary"
                      />
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        Not called yet
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={user.status}
                      size="small"
                      color={getStatusColor(user.status)}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      onClick={() => handleCall(user)}
                      color="primary"
                      title="Call"
                    >
                      <PhoneIcon />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleOpenDialog(user)}
                      title="Edit"
                    >
                      <EditIcon />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleDelete(user.id)}
                      color="error"
                      title="Delete"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={totalUsers}
          page={page}
          onPageChange={handleChangePage}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={handleChangeRowsPerPage}
          rowsPerPageOptions={[25, 50, 100, 200]}
        />
      </TableContainer>

      {/* Delete All Confirmation Dialog */}
      <Dialog open={deleteAllDialogOpen} onClose={() => setDeleteAllDialogOpen(false)}>
        <DialogTitle>Delete All Users</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete ALL users? This action cannot be undone.
            <br />
            <strong>Total users: {totalUsers}</strong>
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteAllDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDeleteAll} color="error" variant="contained">
            Delete All
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add/Edit Dialog */}
      <UserEditDialog
        open={openDialog}
        editingUser={editingUser}
        formData={formData}
        onClose={handleCloseDialog}
        onInputChange={handleInputChange}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}

export default UserManagement;

